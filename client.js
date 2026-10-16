/**
 * dsh-browser-control — Client half.
 *
 * This is the half that can actually touch a page: the right-Sidebar browser
 * keeps its pages in Electron `<webview>` guests inside this renderer, and only
 * code running here can call `webview.executeJavaScript()`.
 *
 * It runs as a self-contained long-poll worker:
 *
 *   1. `GET <base>/next` holds the request open until the Host has a task;
 *   2. the task runs against the target tab;
 *   3. `POST <base>/result` reports the outcome;
 *   4. repeat.
 *
 * The worker starts on plugin activation and stops when the plugin unloads, so
 * an idle DSH page costs one open loopback request and no timer.
 *
 * The bundle is plain JavaScript in the Harness's lazy-CJS bundle format: no
 * build step. It draws no UI, so it never needs `react`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-control',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    /** Route prefix owned by this plugin's Host half. */
    var BASE = '/dsh-browser-control'
    /** Attribute the sidebar browser puts on every page carrier it owns. */
    var FRAME_SELECTOR = '[data-sidebar-browser-frame]'
    /** Attribute this plugin uses to remember its own tab identity. */
    var TAB_ATTRIBUTE = 'data-dsh-browser-tab'
    /**
     * Hard cap on one payload in either direction.
     *
     * This must stay under the Host route's body limit; it is sized for a
     * screenshot data URL, which is by far the largest thing sent back. A
     * retina capture of a sidebar-sized pane base64-encodes to roughly 0.5 MiB,
     * so a smaller cap rejected exactly the case the tool exists for.
     */
    var MAX_PAYLOAD = 4 * 1024 * 1024
    /** Screenshot budget: downscale below this so the payload always fits. */
    var SHOT_BUDGET = 2 * 1024 * 1024
    /** Cap on one evaluation's serialized result. */
    var MAX_EVAL = 200 * 1024
    /** How long click/type wait for the page to settle. */
    var SETTLE_MS = 600
    /** Retry delay after a transport failure. */
    var RETRY_MS = 1500

    /**
     * Build or reuse this page's stable client id.
     * @returns {string} the id.
     */
    function clientId() {
      var key = 'dsh-browser-control:client-id'
      try {
        var existing = window.sessionStorage.getItem(key)
        if (typeof existing === 'string' && existing !== '') return existing
        var created = 'c-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)
        window.sessionStorage.setItem(key, created)
        return created
      } catch (error) {
        return 'c-ephemeral-' + Math.random().toString(36).slice(2)
      }
    }

    /**
     * Collect the live sidebar browser carriers in DOM order.
     * @returns {Array<{index: number, el: Element, frameType: string}>} the carriers.
     */
    function frames() {
      var found = document.querySelectorAll(FRAME_SELECTOR)
      var out = []
      for (var i = 0; i < found.length; i += 1) {
        var el = found[i]
        if (!el.isConnected) continue
        out.push({
          index: out.length,
          el: el,
          frameType: el.tagName.toLowerCase() === 'webview' ? 'webview' : 'iframe',
        })
      }
      return out
    }

    /**
     * Read one carrier's address without throwing on a cross-origin iframe.
     * @param {{el: Element, frameType: string}} frame - the carrier.
     * @returns {string} its URL, or an empty string.
     */
    function frameUrl(frame) {
      try {
        if (frame.frameType === 'webview' && typeof frame.el.getURL === 'function') {
          return String(frame.el.getURL() || '')
        }
        var src = frame.el.getAttribute('src')
        return typeof src === 'string' ? src : ''
      } catch (error) {
        return ''
      }
    }

    /**
     * Read one carrier's observed title.
     * @param {{el: Element}} frame - the carrier.
     * @returns {string} its title, or an empty string.
     */
    function frameTitle(frame) {
      try {
        if (typeof frame.el.getTitle === 'function') {
          var title = frame.el.getTitle()
          if (typeof title === 'string' && title !== '') return title
        }
      } catch (error) {
        /* a destroyed or not-yet-attached guest has no title */
      }
      var label = frame.el.getAttribute('aria-label') || frame.el.getAttribute('title')
      return typeof label === 'string' ? label : ''
    }

    /**
     * Test whether a carrier still loads.
     * @param {{el: Element}} frame - the carrier.
     * @returns {boolean} whether it reports loading.
     */
    function frameLoading(frame) {
      try {
        if (typeof frame.el.isLoading === 'function') return frame.el.isLoading() === true
      } catch (error) {
        /* an unreadable state counts as settled */
      }
      return false
    }

    /**
     * Test whether any part of a carrier is on screen.
     * @param {{el: Element}} frame - the carrier.
     * @returns {boolean} whether it is visible.
     */
    function frameVisible(frame) {
      try {
        var rect = frame.el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      } catch (error) {
        return false
      }
    }

    /**
     * Describe one carrier as the Host's tab record.
     * @param {{el: Element, frameType: string}} frame - the carrier.
     * @param {{tabId: string}} identity - catalog identity.
     * @returns {Record<string, unknown>} the tab record.
     */
    function tabRecord(frame, identity) {
      var focused = document.activeElement
      var active = frame.el === focused || (focused !== null && frame.el.contains(focused)) || frameVisible(frame)
      var record = {
        tabId: identity.tabId,
        title: frameTitle(frame) || frameUrl(frame) || 'Untitled page',
        url: frameUrl(frame),
        frameType: frame.frameType,
        active: active,
        loading: frameLoading(frame),
      }
      if (frame.frameType === 'iframe') {
        var sandbox = frame.el.getAttribute('sandbox')
        record.sandboxed = typeof sandbox === 'string'
      } else {
        // Electron webviews never expose a DOM sandbox attribute; the main
        // process owns their isolation through webPreferences.
        record.sandboxed = true
      }
      return record
    }

    /**
     * Build the carrier catalog, assigning each carrier a stable tab id.
     * @returns {{tabs: Array<Record<string, unknown>>, carriers: Array<{frame: object, tab: Record<string, unknown>}>}} the catalog.
     */
    function catalog() {
      var list = frames()
      var carriers = []
      var tabs = []
      for (var i = 0; i < list.length; i += 1) {
        var frame = list[i]
        var tabId = frame.el.getAttribute(TAB_ATTRIBUTE)
        if (typeof tabId !== 'string' || tabId === '') {
          tabId = 'tab-' + i + '-' + Math.random().toString(36).slice(2, 8)
          try {
            frame.el.setAttribute(TAB_ATTRIBUTE, tabId)
          } catch (error) {
            /* a carrier that refuses the attribute still gets a usable record */
          }
        }
        var tab = tabRecord(frame, { tabId: tabId })
        tabs.push(tab)
        carriers.push({ frame: frame, tab: tab })
      }
      return { tabs: tabs, carriers: carriers }
    }

    /**
     * Choose the carrier a task targets.
     * @param {{tabs: Array<Record<string, unknown>>, carriers: Array<{frame: object, tab: Record<string, unknown>}>}} value - the catalog.
     * @param {string|undefined} wanted - the task's `tab` argument.
     * @returns {{frame: object, tab: Record<string, unknown>}} the chosen carrier.
     */
    function choose(value, wanted) {
      var carriers = value.carriers
      if (carriers.length === 0) {
        throw new Error('no sidebar browser tab is open. Open the right Sidebar browser (Ctrl+T) and load a page first.')
      }
      if (typeof wanted === 'string' && wanted.trim() !== '') {
        var needle = wanted.trim()
        var byId = carriers.filter(function (entry) { return entry.tab.tabId === needle })
        if (byId.length > 0) return byId[0]
        var parsed = Number(needle)
        if (Number.isInteger(parsed) && parsed >= 0 && parsed < carriers.length) return carriers[parsed]
        var lowered = needle.toLowerCase()
        var byTitle = carriers.filter(function (entry) { return String(entry.tab.title).toLowerCase().indexOf(lowered) !== -1 })
        if (byTitle.length > 0) return byTitle[0]
        var byUrl = carriers.filter(function (entry) { return String(entry.tab.url).toLowerCase().indexOf(lowered) !== -1 })
        if (byUrl.length > 0) return byUrl[0]
        var open = value.tabs.map(function (tab) { return tab.tabId + ' (' + tab.url + ')' }).join(', ')
        throw new Error('no sidebar browser tab matches ' + JSON.stringify(needle) + '. Open tabs: ' + open)
      }
      var active = carriers.filter(function (entry) { return entry.tab.active === true })
      return active.length > 0 ? active[0] : carriers[0]
    }

    /**
     * Run one expression inside a carrier's page.
     * @param {{frame: object, tab: Record<string, unknown>}} target - the chosen carrier.
     * @param {string} expression - JavaScript evaluating to a JSON string.
     * @param {boolean} userGesture - whether to run with a user gesture.
     * @returns {Promise<any>} the decoded value.
     */
    async function evaluate(target, expression, userGesture) {
      var el = target.frame.el
      if (target.frame.frameType !== 'webview') {
        throw new Error(
          'this sidebar tab is an iframe, not an Electron webview, so its content cannot be read or changed. '
          + 'Use the DSH desktop app with the sidebar browser tab to control page content.',
        )
      }
      if (typeof el.executeJavaScript !== 'function') {
        throw new Error('the sidebar browser page is not ready yet; wait for it to finish loading and retry')
      }
      var raw = await el.executeJavaScript(expression, userGesture === true)
      try {
        // Diagnostics only: the last expression and its raw answer, so a failed
        // page operation can be inspected from the console.
        window.__DSH_BROWSER_CONTROL_DEBUG__ = { expression: expression, raw: raw }
      } catch (error) {
        /* a frozen window is not a reason to fail the task */
      }
      if (typeof raw !== 'string') return raw
      try {
        return JSON.parse(raw)
      } catch (error) {
        return raw
      }
    }

    /**
     * The in-page helper, evaluated inside the visited page.
     *
     * It is written as a real function (not assembled from strings) so that
     * `Function.prototype.toString()` can carry it into the guest without any
     * escaping layer. It returns a value plus the text it wants the Host to
     * see; serialization happens outside, in this file.
     * @returns {Record<string, unknown>} the helper API.
     */
    function pageHelper() {
      function textOf(element) {
        var raw = element.innerText
        if (typeof raw !== 'string' || raw === '') raw = element.textContent || ''
        return String(raw).replace(/\s+/g, ' ').trim()
      }
      function visible(element) {
        if (!element.isConnected) return false
        var rect = element.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) return false
        var style = window.getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      }
      function unique(candidate) {
        try {
          return document.querySelectorAll(candidate).length === 1
        } catch (error) {
          return false
        }
      }
      function selector(element) {
        if (!(element instanceof Element)) return ''
        if (element.id && /^[A-Za-z][\w:.-]*$/.test(element.id)) return '#' + element.id
        var tag = element.tagName.toLowerCase()
        var attributes = ['data-testid', 'data-test', 'name', 'aria-label', 'placeholder', 'type']
        for (var i = 0; i < attributes.length; i += 1) {
          var value = element.getAttribute(attributes[i])
          if (typeof value !== 'string' || value === '' || value.length > 60) continue
          var candidate = tag + '[' + attributes[i] + '=' + JSON.stringify(value) + ']'
          if (unique(candidate)) return candidate
        }
        var path = []
        var node = element
        while (node instanceof Element && path.length < 6) {
          var part = node.tagName.toLowerCase()
          var parent = node.parentElement
          if (parent !== null) {
            var siblings = Array.prototype.filter.call(parent.children, function (child) {
              return child.tagName === node.tagName
            })
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
          }
          path.unshift(part)
          var joined = path.join(' > ')
          if (unique(joined)) return joined
          node = parent
        }
        return path.join(' > ')
      }
      function find(selectorValue, textValue) {
        if (typeof selectorValue === 'string' && selectorValue.trim() !== '') {
          var direct = document.querySelector(selectorValue)
          if (direct !== null) return direct
          throw new Error('no element matches selector ' + JSON.stringify(selectorValue))
        }
        if (typeof textValue === 'string' && textValue.trim() !== '') {
          var wanted = textValue.replace(/\s+/g, ' ').trim().toLowerCase()
          var pool = document.querySelectorAll(
            'a, button, [role=button], input[type=submit], input[type=button], label, summary, [onclick]',
          )
          // Three passes, in preference order, over the whole page:
          //   1. exact text and visible  — always the intended element;
          //   2. exact text, hidden      — a menu entry that opens on click;
          //   3. partial text, visible   — only if nothing matched exactly.
          // Choosing during one DOM scan instead would pick whichever partial
          // match appeared first, which is how clicking "用户" landed on the
          // footer's "用户协议" link.
          var exactVisible = null
          var exactHidden = null
          var partialVisible = null
          var nearby = []
          for (var i = 0; i < pool.length; i += 1) {
            var candidate = pool[i]
            var value = textOf(candidate).toLowerCase()
            if (value === '') continue
            if (value === wanted) {
              if (visible(candidate)) {
                if (exactVisible === null) exactVisible = candidate
              } else if (exactHidden === null) {
                exactHidden = candidate
              }
              continue
            }
            if (value.indexOf(wanted) !== -1) {
              if (visible(candidate) && partialVisible === null) partialVisible = candidate
              if (nearby.length < 5) nearby.push(textOf(candidate).slice(0, 40))
            }
          }
          if (exactVisible !== null) return exactVisible
          if (exactHidden !== null) return exactHidden
          if (partialVisible !== null) return partialVisible
          // Nothing matched partially either, so `nearby` is empty. Report what
          // the page does offer, which is far more useful than a bare "no match".
          var sample = []
          for (var s = 0; s < pool.length && sample.length < 6; s += 1) {
            var label = textOf(pool[s])
            if (label !== '' && visible(pool[s])) sample.push(label.slice(0, 40))
          }
          throw new Error(
            'no element has the text ' + JSON.stringify(textValue)
            + (sample.length > 0
              ? '; closest matches on this page: ' + sample.map(function (t) { return JSON.stringify(t) }).join(', ')
              : '; this page has no labelled links or buttons'),
          )
        }
        throw new Error('provide either selector or text')
      }
      function delayed() {
        return new Promise(function (resolve) {
          setTimeout(resolve, 50)
        })
      }
      function settle(ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms)
        })
      }
      function snapshotText() {
        return String(document.body ? document.body.innerText : '').slice(0, 8000)
      }
      function state() {
        return { url: location.href, title: document.title, text: snapshotText() }
      }
      function describe(value) {
        if (value === undefined) return 'undefined'
        try {
          var text = JSON.stringify(value, null, 2)
          if (typeof text === 'string') return text
        } catch (error) {
          /* circular structures fall through to the shallow rendering */
        }
        try {
          return String(value)
        } catch (error) {
          return '[unserializable value]'
        }
      }
      return {
        textOf: textOf,
        visible: visible,
        selector: selector,
        find: find,
        delayed: delayed,
        settle: settle,
        snapshotText: snapshotText,
        state: state,
        describe: describe,
      }
    }

    /**
     * Serialize the in-page helper for injection into the guest.
     * @returns {string} a self-contained factory expression.
     */
    function helperFactorySource() {
      return '(' + pageHelper.toString() + ')()'
    }

    /**
     * Wrap a callback so the guest always answers with a JSON envelope.
     *
     * `callback` runs inside the page as `(page, args)` where `args` is the
     * argument array, and returns `{ value, text }`.
     * @param {Function} callback - the in-page body.
     * @param {Array<unknown>} [args] - the argument array the callback reads.
     * @returns {string} an expression evaluating to a JSON string.
     */
    function pageExpression(callback, args) {
      var table = (args === undefined ? [] : args).map(function (entry) {
        return JSON.stringify(entry === undefined ? null : entry)
      })
      return '(async () => {'
        + ' var __args = [' + table.join(',') + '];'
        + ' var __dsh = ' + helperFactorySource() + ';'
        + ' try {'
        + '  var __out = await (' + callback.toString() + ')(__dsh, __args);'
        + '  var __value = __out ? __out.value : undefined;'
        + '  var __text = __out && typeof __out.text === "string" ? __out.text : __dsh.describe(__value);'
        + '  var __payload = JSON.stringify({ value: __value === undefined ? null : __value, text: __text });'
        + '  return typeof __payload === "string" ? __payload : JSON.stringify({ value: null, text: __text });'
        + ' } catch (error) {'
        + '  return JSON.stringify({ error: String((error && error.message) || error), stack: error && error.stack ? String(error.stack) : undefined });'
        + ' }'
        + '})()'
    }

    /**
     * Unwrap a page envelope, turning an in-page failure into a thrown error.
     * @param {any} envelope - the decoded envelope.
     * @returns {any} the envelope's `value`.
     */
    function unwrap(envelope) {
      if (envelope === null || typeof envelope !== 'object') throw new Error('the page returned an unreadable response')
      if (typeof envelope.error === 'string') throw new Error(envelope.error)
      return envelope.value
    }

    /**
     * The `read` body: page text plus interactable elements with selectors.
     *
     * Element text travels in a separate table (`entries`) built inside the
     * page, so the callback source never has to embed page-controlled text.
     * @param {Record<string, unknown>} page - the page helper.
     * @param {Array<unknown>} args - `[options]`.
     * @returns {Record<string, unknown>} the page state, text, element table, and text table.
     */
    function readBody(page, args) {
      var options = args[0] === undefined || args[0] === null ? {} : args[0]
      var requested = typeof options.selector === 'string' ? options.selector : ''
      var limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200000, Math.trunc(options.limit))) : 20000
      var includeElements = options.includeElements !== false
      var root = requested.trim() === '' ? document.body : document.querySelector(requested)
      if (root === null || root === undefined) throw new Error('no element matches selector ' + JSON.stringify(requested))
      var inner = typeof root.innerText === 'string' && root.innerText !== '' ? root.innerText : root.textContent || ''
      var full = String(inner).replace(/\n{3,}/g, '\n\n').trim()
      var shown = full.slice(0, limit)
      var entries = []
      var truncatedNodes = false
      if (includeElements) {
        var pool = root.querySelectorAll(
          'a[href], button, input, select, textarea, [role=button], [contenteditable=true], summary',
        )
        for (var i = 0; i < pool.length; i += 1) {
          var el = pool[i]
          if (!page.visible(el)) continue
          if (entries.length >= 200) {
            truncatedNodes = true
            break
          }
          var tag = el.tagName.toLowerCase()
          var kind = tag === 'input' ? 'input' : tag === 'a' ? 'link' : el.getAttribute('contenteditable') === 'true' ? 'editable' : 'control'
          var entry = { tag: tag, kind: kind, selector: page.selector(el), text: page.textOf(el).slice(0, 200) }
          if (el.id) entry.id = String(el.id)
          if (el.name) entry.name = String(el.name)
          if (el.type) entry.type = String(el.type)
          entries.push(entry)
        }
      }
      return {
        value: {
          url: location.href,
          title: document.title,
          selector: requested,
          text: shown,
          textTruncated: full.length > shown.length,
          entries: entries,
          nodesTruncated: truncatedNodes,
        },
        text: shown,
      }
    }

    /**
     * The `eval` body: run caller-supplied code in the page.
     * @param {Record<string, unknown>} page - the page helper.
     * @param {Array<unknown>} args - `[code]`.
     * @returns {Record<string, unknown>} the raw value plus the Host-facing text.
     */
    function evalBody(page, args) {
      var code = String(args[0] === undefined || args[0] === null ? '' : args[0])
      var factory = new Function('__dsh', 'return (async () => {' + code + '})();')
      return factory(page).then(function (value) {
        return { value: value === undefined ? null : value, text: page.describe(value) }
      })
    }

    /**
     * The `click` body: dispatch a full pointer/click sequence on one element.
     * @param {Record<string, unknown>} page - the page helper.
     * @param {Array<unknown>} args - `[selector, text, settleMs]`.
     * @returns {Record<string, unknown>} the click description and page state.
     */
    function clickBody(page, args) {
      var element = page.find(args[0], args[1])
      if (!page.visible(element)) throw new Error('the matched element is not visible')
      try {
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch (error) {
        /* an element that cannot scroll is still clickable */
      }
      return page.delayed().then(function () {
        var rect = element.getBoundingClientRect()
        var x = rect.left + Math.max(Math.min(rect.width / 2, Math.max(rect.width - 1, 1)), 1)
        var y = rect.top + Math.max(Math.min(rect.height / 2, Math.max(rect.height - 1, 1)), 1)
        var common = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1,
        }
        element.dispatchEvent(new PointerEvent('pointerdown', common))
        element.dispatchEvent(new MouseEvent('mousedown', common))
        element.dispatchEvent(new PointerEvent('pointerup', common))
        element.dispatchEvent(new MouseEvent('mouseup', common))
        element.dispatchEvent(new MouseEvent('click', common))
        return page.settle(Number(args[2]) || 600)
      }).then(function () {
        var description = '<' + element.tagName.toLowerCase() + '> ' + page.textOf(element).slice(0, 120)
        return {
          value: {
            clicked: description,
            selector: page.selector(element),
            url: location.href,
            title: document.title,
            text: page.snapshotText(),
          },
          text: 'clicked ' + description,
        }
      })
    }

    /**
     * The `type` body: set a field's value through its native setter.
     * @param {Record<string, unknown>} page - the page helper.
     * @param {Array<unknown>} args - `[selector, textMatch, value, submit, settleMs]`.
     * @returns {Record<string, unknown>} the field description and page state.
     */
    function typeBody(page, args) {
      var element = page.find(args[0], args[1])
      var value = String(args[2] === undefined || args[2] === null ? '' : args[2])
      var submit = args[3] === true
      if (!page.visible(element)) throw new Error('the matched element is not visible')
      try {
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch (error) {
        /* an element that cannot scroll is still typable */
      }
      return page.delayed().then(function () {
        if (typeof element.focus === 'function') element.focus()
        var descriptor = Object.getOwnPropertyDescriptor(element, 'value')
        var setter = descriptor !== undefined && typeof descriptor.set === 'function' ? descriptor.set : undefined
        var prototype = Object.getPrototypeOf(element)
        while (prototype !== null && setter === undefined) {
          var candidate = Object.getOwnPropertyDescriptor(prototype, 'value')
          if (candidate !== undefined && typeof candidate.set === 'function') setter = candidate.set
          prototype = Object.getPrototypeOf(prototype)
        }
        if (setter !== undefined) setter.call(element, value)
        else if ('value' in element) element.value = value
        else element.textContent = value
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        if (submit) {
          var keyOptions = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, composed: true }
          var accepted = element.dispatchEvent(new KeyboardEvent('keydown', keyOptions))
          if (accepted) accepted = element.dispatchEvent(new KeyboardEvent('keypress', keyOptions))
          element.dispatchEvent(new KeyboardEvent('keyup', keyOptions))
          var form = element.form || (typeof element.closest === 'function' ? element.closest('form') : null)
          if (accepted && form !== null && typeof form.requestSubmit === 'function') {
            try {
              form.requestSubmit()
            } catch (error) {
              /* a form that refuses requestSubmit still saw the Enter key */
            }
          }
        }
        return page.settle(Number(args[4]) || 600)
      }).then(function () {
        var current = 'value' in element ? String(element.value) : page.textOf(element)
        return {
          value: {
            typed: element.tagName.toLowerCase(),
            value: current.slice(0, 200),
            submitted: submit,
            url: location.href,
            title: document.title,
            text: page.snapshotText(),
          },
          text: 'entered ' + JSON.stringify(current.slice(0, 120)) + (submit ? ' and pressed Enter' : ''),
        }
      })
    }

    /**
     * The shared state snapshot body.
     * @param {Record<string, unknown>} page - the page helper.
     * @returns {Record<string, unknown>} the page state.
     */
    function stateBody(page) {
      var state = page.state()
      return { value: state, text: state.title + ' — ' + state.url }
    }

    /**
     * Wait for a carrier to finish loading, bounded.
     * @param {{el: Element}} target - the carrier.
     * @returns {Promise<void>} after the page settles.
     */
    function settlePage(target) {
      return new Promise(function (resolve) {
        var done = false
        var finish = function () {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        var timer = setTimeout(finish, 15000)
        try {
          if (typeof target.el.addEventListener === 'function') {
            target.el.addEventListener('did-stop-loading', finish, { once: true })
            target.el.addEventListener('did-fail-load', finish, { once: true })
          }
        } catch (error) {
          finish()
        }
      })
    }

    /**
     * Promise-based delay.
     * @param {number} ms - milliseconds.
     * @returns {Promise<void>} resolves after the delay.
     */
    function settle(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms)
      })
    }

    /**
     * Fold a freshly observed URL and title back into a tab record.
     * @param {Record<string, any>} tab - the catalog record.
     * @param {{url?: string, title?: string}} state - the observed page state.
     * @returns {Record<string, any>} the refreshed record.
     */
    function mergeTab(tab, state) {
      var merged = {
        tabId: tab.tabId,
        title: typeof state.title === 'string' && state.title !== '' ? state.title : tab.title,
        url: typeof state.url === 'string' && state.url !== '' ? state.url : tab.url,
        frameType: tab.frameType,
        active: tab.active,
        loading: tab.loading,
      }
      if (tab.sandboxed !== undefined) merged.sandboxed = tab.sandboxed
      return merged
    }

    /**
     * Report a value's JSON kind for the tool result header.
     * @param {unknown} value - the value.
     * @returns {string} the kind.
     */
    function kindOf(value) {
      if (value === null) return 'null'
      if (Array.isArray(value)) return 'array'
      return typeof value
    }

    /**
     * Run one task against the sidebar browser.
     * @param {{id: string, action: string, args: Record<string, any>}} task - the claimed task.
     * @returns {Promise<any>} the action's declared result value.
     */
    async function run(task) {
      var args = task.args === undefined || task.args === null ? {} : task.args
      var value = catalog()

      if (task.action === 'list') return { tabs: value.tabs }

      var target = choose(value, args.tab)

      if (task.action === 'read') {
        var read = unwrap(await evaluate(target, pageExpression(readBody, [{ selector: args.selector, limit: args.limit, includeElements: args.includeElements }]), false))
        var entries = Array.isArray(read.entries) ? read.entries : []
        return {
          tab: mergeTab(target.tab, read),
          selector: typeof read.selector === 'string' ? read.selector : '',
          text: typeof read.text === 'string' ? read.text : '',
          textTruncated: read.textTruncated === true,
          nodes: entries.map(function (entry) {
            var node = { tag: entry.tag, kind: entry.kind, text: entry.text, selector: entry.selector }
            if (entry.id !== undefined) node.id = entry.id
            if (entry.name !== undefined) node.name = entry.name
            if (entry.type !== undefined) node.type = entry.type
            return node
          }),
          nodesTruncated: read.nodesTruncated === true,
        }
      }

      if (task.action === 'eval') {
        var code = String(args.code === undefined ? '' : args.code)
        var evaluated = unwrap(await evaluate(target, pageExpression(evalBody, [code]), true))
        return {
          tab: target.tab,
          result: evaluated,
          resultType: kindOf(evaluated),
          resultTruncated: false,
        }
      }

      if (task.action === 'click') {
        var clicked = unwrap(await evaluate(target, pageExpression(clickBody, [args.selector, args.text, SETTLE_MS]), true))
        return { tab: mergeTab(target.tab, clicked), url: clicked.url, title: clicked.title, text: clicked.text }
      }

      if (task.action === 'type') {
        if (typeof args.text !== 'string') throw new Error('the type action needs `text`')
        var typed = unwrap(await evaluate(target, pageExpression(typeBody, [args.selector, null, args.text, args.submit === true, SETTLE_MS]), true))
        return { tab: mergeTab(target.tab, typed), url: typed.url, title: typed.title, text: typed.text }
      }

      if (task.action === 'navigate') {
        var wanted = String(args.url === undefined ? '' : args.url).trim()
        var parsed
        try {
          parsed = new URL(wanted)
        } catch (error) {
          throw new Error('the navigate action needs an absolute HTTP(S) URL; got ' + JSON.stringify(wanted))
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('the sidebar browser only loads HTTP(S) URLs; got ' + parsed.protocol)
        }
        if (target.frame.frameType !== 'webview' || typeof target.frame.el.loadURL !== 'function') {
          throw new Error('navigate needs a desktop sidebar webview')
        }
        await target.frame.el.loadURL(parsed.href)
        await settlePage(target)
        await settle(300)
        var refreshed = choose(catalog(), target.tab.tabId)
        var state = unwrap(await evaluate(refreshed, pageExpression(stateBody, []), false))
        return { tab: mergeTab(refreshed.tab, state), url: state.url, title: state.title, text: state.text }
      }

      if (task.action === 'screenshot') {
        var el = target.frame.el
        if (typeof el.capturePage !== 'function') throw new Error('screenshots need a desktop sidebar webview')
        var image = await el.capturePage()
        if (image === null || image === undefined || typeof image.toDataURL !== 'function') {
          throw new Error('the page refused to be captured')
        }
        return { tab: target.tab, url: frameUrl(target.frame), ...await encodeShot(image) }
      }

      throw new Error('unsupported action ' + JSON.stringify(task.action))
    }

    /**
     * Encode a captured page, downscaling until the payload fits the budget.
     *
     * A retina capture of a sidebar-sized pane is already about 0.5 MiB once
     * base64-encoded, so returning `toDataURL()` unchanged fails exactly the
     * case this action exists for. The capture is resized in steps and the
     * resulting size is reported either way, so the model knows what it got.
     * @param {any} image - the NativeImage from `capturePage()`.
     * @returns {Promise<{dataUrl: string, width: number, height: number, scaledFrom?: {width: number, height: number}, encodedSize: number}>} the encoded shot.
     */
    async function encodeShot(image) {
      var size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
      var original = { width: size.width || 0, height: size.height || 0 }
      var candidate = image
      var scale = 1
      var dataUrl = candidate.toDataURL()

      while (dataUrl.length > SHOT_BUDGET && scale > 0.25 && typeof candidate.resize === 'function') {
        scale = Math.max(0.25, Math.floor(scale * 0.7 * 100) / 100)
        var nextWidth = Math.max(80, Math.round(original.width * scale))
        var nextHeight = Math.max(80, Math.round(original.height * scale))
        candidate = candidate.resize({ width: nextWidth, height: nextHeight, quality: 'good' })
        dataUrl = candidate.toDataURL()
      }

      var finalSize = typeof candidate.getSize === 'function' ? candidate.getSize() : original
      var result = {
        dataUrl: dataUrl,
        width: finalSize.width || original.width,
        height: finalSize.height || original.height,
        encodedSize: dataUrl.length,
      }
      if (scale < 1) result.scaledFrom = original
      return result
    }

    /**
     * Post one task outcome back to the Host, retrying without `keepalive`.
     * @param {string} id - this client's id.
     * @param {string} taskId - the settled task.
     * @param {{result?: unknown, error?: string}} outcome - result or failure text.
     * @returns {Promise<void>} after the answer was sent or abandoned.
     */
    async function sendResult(id, taskId, outcome) {
      var payload = JSON.stringify({ clientId: id, taskId: taskId, result: outcome.result, error: outcome.error })
      if (typeof payload !== 'string') payload = JSON.stringify({ clientId: id, taskId: taskId, error: 'the page result is not JSON-serializable' })
      if (payload.length > MAX_PAYLOAD) {
        payload = JSON.stringify({
          clientId: id,
          taskId: taskId,
          error: 'the page result is ' + payload.length + ' characters, over the ' + MAX_PAYLOAD + ' limit',
        })
      }
      var init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }
      try {
        await fetch(BASE + '/result', Object.assign({}, init, { keepalive: true }))
      } catch (error) {
        try {
          await fetch(BASE + '/result', init)
        } catch (retryError) {
          console.warn('[dsh-browser-control] could not report a task result:', retryError)
        }
      }
    }

    /**
     * The long-poll worker: claim, run, report, repeat.
     * @param {string} id - this client's id.
     * @param {{aborted: boolean, controller: AbortController|null}} state - worker lifetime.
     * @returns {Promise<void>} resolves when the worker stops.
     */
    async function work(id, state) {
      while (!state.aborted) {
        state.controller = new AbortController()
        var response
        var tabCount = 0
        try {
          tabCount = frames().length
        } catch (error) {
          tabCount = 0
        }
        try {
          response = await fetch(BASE + '/next?c=' + encodeURIComponent(id) + '&tabs=' + tabCount, {
            signal: state.controller.signal,
            cache: 'no-store',
          })
        } catch (error) {
          state.controller = null
          if (state.aborted) return
          await settle(RETRY_MS)
          continue
        }
        state.controller = null
        if (state.aborted) return
        if (!response.ok) {
          await settle(RETRY_MS)
          continue
        }
        var body
        try {
          body = await response.json()
        } catch (error) {
          await settle(RETRY_MS)
          continue
        }
        if (body === null || typeof body !== 'object' || body.status !== 'task' || body.task === undefined) continue
        var task = body.task
        var outcome
        try {
          outcome = { result: await run(task) }
        } catch (error) {
          outcome = { error: error instanceof Error ? error.message : String(error) }
        }
        await sendResult(id, task.id, outcome)
      }
    }

    /** Required services: none beyond the bundle's own platform baseline. */
    var inject = []

    /**
     * Start the worker for this page.
     * @param {any} ctx - the Client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      var id = clientId()
      var state = { aborted: false, controller: null }
      ctx.effect(function () {
        var running = work(id, state).catch(function (error) {
          if (!state.aborted) console.warn('[dsh-browser-control] worker stopped:', error)
        })
        return function () {
          state.aborted = true
          if (state.controller !== null) {
            try {
              state.controller.abort()
            } catch (error) {
              /* an already-settled request needs no abort */
            }
            state.controller = null
          }
          return running
        }
      }, 'dsh-browser-control: bridge worker')
      window.__DSH_BROWSER_CONTROL__ = {
        clientId: id,
        base: BASE,
        tabs: function () {
          return frames().length
        },
        status: function () {
          return fetch(BASE + '/status', { cache: 'no-store' }).then(function (response) {
            return response.json()
          })
        },
      }
    }

    module.exports = { apply: apply, inject: inject, name: 'dsh-browser-control' }
    return module.exports
  },
})
