    
    (function() {
      const vscode = acquireVsCodeApi();
      const MERMAID_URI = window.__MYSTI_BOOT__.mermaidUri;
      const LOGO_URI = window.__MYSTI_BOOT__.logoUri;
      const MYSTI_VERSION = window.__MYSTI_BOOT__.version;
      var ICON_URIS = window.__MYSTI_BOOT__.iconUris;
      var CLAUDE_LOGO = window.__MYSTI_BOOT__.claudeLogoUri;
      var OPENAI_LOGO_LIGHT = window.__MYSTI_BOOT__.openaiLogoLightUri;
      var OPENAI_LOGO_DARK = window.__MYSTI_BOOT__.openaiLogoDarkUri;
      var GEMINI_LOGO = window.__MYSTI_BOOT__.geminiLogoUri;
      var CLINE_LOGO = window.__MYSTI_BOOT__.clineLogoUri;
      var COPILOT_LOGO = window.__MYSTI_BOOT__.copilotLogoUri;
      var CURSOR_LOGO = window.__MYSTI_BOOT__.cursorLogoUri;
      var OPENCLAW_LOGO = window.__MYSTI_BOOT__.openclawLogoUri;
      var OPENCODE_LOGO = window.__MYSTI_BOOT__.opencodeLogoUri;
      var OLLAMA_LOGO = window.__MYSTI_BOOT__.ollamaLogoUri;
      var LOCALAI_LOGO = window.__MYSTI_BOOT__.localaiLogoUri;
      var QWEN_LOGO = window.__MYSTI_BOOT__.qwenLogoUri;
      var MYSTI_LOGO = window.__MYSTI_BOOT__.logoUri;

      // Theme detection for theme-aware provider logos
      function isDarkTheme() {
        return document.body.classList.contains('vscode-dark') ||
               document.body.classList.contains('vscode-high-contrast');
      }

      // Plan 02 Phase 2: provider manifest schema this webview build was
      // generated against. Payloads with a different schemaVersion are
      // ignored (a cached webview must not trust an incompatible shape).
      var EXPECTED_MANIFEST_SCHEMA_VERSION = window.__MYSTI_BOOT__.manifestSchemaVersion;

      // Manifest entries carry icon paths relative to the extension's
      // resources/ folder; the webview can only use pre-resolved webview
      // URIs, so this map translates manifest icon paths to the URIs
      // injected at HTML-generation time. Keyed by asset path — NOT by
      // provider id — so render logic stays provider-name free.
      var LOGO_BY_ICON_PATH = {
        'icons/Claude.png': CLAUDE_LOGO,
        'icons/openai.svg': OPENAI_LOGO_LIGHT,
        'icons/openai_white.png': OPENAI_LOGO_DARK,
        'icons/gemini.png.webp': GEMINI_LOGO,
        'icons/cline.png': CLINE_LOGO,
        'icons/copilot.png': COPILOT_LOGO,
        'icons/cursor.png': CURSOR_LOGO,
        'icons/openclaw.png': OPENCLAW_LOGO,
        'icons/opencode.png': OPENCODE_LOGO,
        'icons/ollama.png': OLLAMA_LOGO,
        'icons/localai.png': LOCALAI_LOGO,
        'icons/qwen.png': QWEN_LOGO
      };

      // Mermaid lazy loading
      var mermaidLoaded = false;
      var mermaidLoadPromise = null;

      function loadMermaid() {
        if (mermaidLoaded) return Promise.resolve();
        if (mermaidLoadPromise) return mermaidLoadPromise;

        mermaidLoadPromise = new Promise(function(resolve, reject) {
          var script = document.createElement('script');
          script.src = MERMAID_URI;
          script.onload = function() {
            mermaid.initialize({
              startOnLoad: false,
              theme: 'dark',
              securityLevel: 'strict'
            });
            mermaidLoaded = true;
            resolve();
          };
          script.onerror = reject;
          document.head.appendChild(script);
        });
        return mermaidLoadPromise;
      }

      function renderMermaidDiagrams() {
        var mermaidBlocks = document.querySelectorAll('.mermaid-pending');
        if (mermaidBlocks.length === 0) return;

        loadMermaid().then(function() {
          mermaidBlocks.forEach(function(block, index) {
            var code = block.textContent;
            var id = 'mermaid-' + Date.now() + '-' + index;
            try {
              mermaid.render(id, code).then(function(result) {
                block.innerHTML = result.svg;
                block.classList.remove('mermaid-pending');
                block.classList.add('mermaid-rendered');
              }).catch(function(e) {
                block.classList.add('mermaid-error');
                console.error('Mermaid render error:', e);
              });
            } catch (e) {
              block.classList.add('mermaid-error');
              console.error('Mermaid render error:', e);
            }
          });
        }).catch(function(e) {
          console.error('Failed to load Mermaid:', e);
        });
      }

      // Configure marked if available
      if (typeof marked !== 'undefined') {
        var renderer = new marked.Renderer();
        var originalCode = renderer.code.bind(renderer);

        renderer.code = function(code, lang, escaped) {
          if (typeof code === 'object') {
            lang = code.lang;
            escaped = code.escaped;
            code = code.text;
          }

          if (lang === 'mermaid') {
            return '<div class="mermaid-diagram mermaid-pending">' + escapeHtmlForMarked(code) + '</div>';
          }

          // Check for diff content - use professional diff component
          if (lang === 'diff' || lang === 'patch' || isDiffContentMarked(code)) {
            return formatDiffContentMarked(code);
          }

          // Return code block for Prism highlighting
          var langClass = lang ? 'language-' + lang : '';
          return '<pre><code class="' + langClass + '">' + escapeHtmlForMarked(code) + '</code></pre>';
        };

        marked.setOptions({
          gfm: true,
          breaks: true,
          renderer: renderer
        });
      }

      function escapeHtmlForMarked(text) {
        if (!text) return '';
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function isDiffContentMarked(content) {
        var lines = content.split('\n');
        var diffMarkers = 0;
        var checkLines = Math.min(lines.length, 20);
        for (var i = 0; i < checkLines; i++) {
          var line = lines[i];
          // Exclude CSS custom properties (--var) from diff detection
          if (line.startsWith('+') || (line.startsWith('-') && !line.startsWith('--')) || line.startsWith('@@')) {
            diffMarkers++;
          }
        }
        return diffMarkers > checkLines * 0.2;
      }

      function formatDiffContentMarked(content) {
        var lines = content.split('\n');
        var additions = 0;
        var deletions = 0;
        var fileName = '';
        var filePath = '';
        var diffLines = [];
        var lineNum = 1;
        var previewLimit = 10;
        var diffId = 'diff-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

        // Parse diff and collect data
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Extract file path from diff headers
          if (line.startsWith('+++ b/')) {
            filePath = line.substring(6);
          } else if (line.startsWith('+++ ') && !filePath) {
            filePath = line.substring(4);
          } else if (line.startsWith('diff --git')) {
            var gitMatch = line.match(/b\/(.+)$/);
            if (gitMatch) filePath = gitMatch[1];
          }

          // Skip header lines for display
          if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
            continue;
          }

          // Parse hunk header for line numbers
          if (line.startsWith('@@')) {
            var hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
            if (hunkMatch) lineNum = parseInt(hunkMatch[1], 10);
            continue;
          }

          var lineClass = 'file-edit-line';
          var lineNumDisplay = '';

          if (line.startsWith('+')) {
            lineClass += ' addition';
            additions++;
            lineNumDisplay = lineNum++;
          } else if (line.startsWith('-')) {
            lineClass += ' deletion';
            deletions++;
            lineNumDisplay = '';
          } else {
            lineClass += ' context';
            lineNumDisplay = lineNum++;
          }

          diffLines.push({
            cls: lineClass,
            num: lineNumDisplay,
            content: line.substring(1) || ' '
          });
        }

        // Extract filename from path
        if (!filePath) filePath = 'changes';
        var pathParts = filePath.split('/');
        fileName = pathParts.pop() || filePath;
        var dirPath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';

        // Build preview (first 10 lines)
        var hasMore = diffLines.length > previewLimit;
        var previewLines = hasMore ? diffLines.slice(0, previewLimit) : diffLines;
        var remainingCount = diffLines.length - previewLimit;

        var previewHtml = '';
        for (var j = 0; j < previewLines.length; j++) {
          var dl = previewLines[j];
          previewHtml += '<div class="' + dl.cls + '">' +
            '<span class="file-edit-line-num">' + (dl.num !== '' ? dl.num : '') + '</span>' +
            '<span class="file-edit-line-content">' + escapeHtmlForMarked(dl.content) + '</span>' +
          '</div>';
        }

        // Encode full diff data for expansion
        var fullDiffData = encodeURIComponent(JSON.stringify(diffLines));

        // Chevron SVG
        var chevronSvg = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>';

        var html = '<div class="file-edit-card" id="' + diffId + '" data-file-path="' + escapeHtmlForMarked(filePath) + '" data-full-diff="' + fullDiffData + '">' +
          '<div class="file-edit-header">' +
            '<span class="file-edit-icon">📄</span>' +
            '<span class="file-edit-filename">' + escapeHtmlForMarked(fileName) + '</span>' +
            '<span class="file-edit-path">' + escapeHtmlForMarked(dirPath) + '</span>' +
            '<div class="file-edit-stats">' +
              (additions > 0 ? '<span class="file-edit-additions">+' + additions + '</span>' : '') +
              (deletions > 0 ? '<span class="file-edit-deletions">-' + deletions + '</span>' : '') +
            '</div>' +
            '<button class="file-edit-collapse-btn" title="Toggle">' + chevronSvg + '</button>' +
          '</div>' +
          '<div class="file-edit-diff">' +
            '<div class="file-edit-diff-content">' + previewHtml + '</div>' +
            (hasMore ? '<button class="file-edit-show-more">Show more... (' + remainingCount + ' lines)</button>' : '') +
          '</div>' +
          '<div class="file-edit-actions">' +
            '<button class="file-edit-btn file-edit-revert">Revert</button>' +
            '<button class="file-edit-btn file-edit-review">Review</button>' +
          '</div>' +
        '</div>';

        return html;
      }

      let state = {
        panelId: null,  // Unique ID for this panel
        workspacePath: '',  // Workspace root for relative path display
        settings: {
          mode: 'ask-before-edit',
          thinkingLevel: 'none',
          accessLevel: 'ask-permission',
          contextMode: 'auto',
          model: 'claude-sonnet-4-5-20250929',
          provider: 'claude-code' // mysti:provider-literals:allow-line — bootstrap default, replaced by initialState
        },
        // Plan 02 Phase 2: capability manifest (ProviderManifestPayload) —
        // delivered on initialState and refreshed via 'manifestUpdated'.
        providerManifest: null,
        context: [],
        attachments: [],
        messages: [],
        isLoading: false,
        providers: [],
        slashCommands: [],
        slashMenuVisible: false,
        slashMenuIndex: 0,
        slashMenuItems: [],
        slashMenuQuery: '',
        quickActions: [],
        // Context usage tracking
        contextUsage: {
          usedTokens: 0,
          contextWindow: 200000,
          percentage: 0
        },
        // Brainstorm mode state
        activeAgent: 'claude-code', // mysti:provider-literals:allow-line — bootstrap default, replaced by initialState
        brainstormSession: null,
        brainstormPhase: null,
        brainstormStrategy: null,
        agentResponses: {},
        discussionContent: {},
        currentDiscussionRound: 0,
        // Autocomplete state
        autocompleteSuggestion: null,
        autocompleteType: null,
        // Permission state
        pendingPermissions: new Map(),
        focusedPermissionId: null,
        // Autonomy level: 'manual' | 'semi-autonomous' | 'autonomous'
        autonomyLevel: 'manual',
        // Track previous level for cancel/revert
        previousAutonomyLevel: 'manual',
        // Agent configuration state (per-conversation)
        agentConfig: {
          personaId: null,
          enabledSkills: []
        },
        availablePersonas: [],
        availableSkills: [],
        // Agent settings (configurable via settings panel)
        agentSettings: {
          autoSuggest: true,
          tokenLimitEnabled: false,
          maxTokenBudget: 0,
          showSuggestions: true
        },
        // Brainstorm agent selection (which 2 agents to use)
        brainstormAgents: ['claude-code', 'openai-codex'], // mysti:provider-literals:allow-line — bootstrap default, replaced by initialState
        // Provider availability for brainstorm section
        providerAvailability: {},
        // Setup state (legacy)
        setup: {
          isChecking: true,
          isReady: false,
          currentStep: 'checking',
          progress: 0,
          message: '',
          providerId: null,
          error: null,
          npmAvailable: true,
          providers: []
        },
        // @-mention state
        mentionQuery: null,
        mentionMenuVisible: false,
        mentionMenuIndex: 0,
        mentionItems: [],
        mentionStartPos: 0,
        workspaceFileCache: [],
        // Setup wizard state (enhanced onboarding)
        wizard: {
          visible: false,
          providers: [],
          npmAvailable: true,
          nodeVersion: null,
          anyReady: false,
          activeSetup: null,
          currentAuthProviderId: null
        }
      };

      // ========================================================================
      // Provider manifest accessors (Plan 02 Phase 2)
      //
      // The webview renders from the capability manifest shipped by the
      // extension (state.providerManifest) — never from provider-name
      // literals. A provider id only selects display identity (name, color,
      // logo, shortId) from its manifest entry.
      // ========================================================================

      function getManifestEntry(providerId) {
        var manifest = state.providerManifest;
        if (!manifest || !manifest.providers) return undefined;
        for (var i = 0; i < manifest.providers.length; i++) {
          if (manifest.providers[i].id === providerId) return manifest.providers[i];
        }
        return undefined;
      }

      // Ordered provider ids — manifest first, providerAvailability keys as a
      // pre-manifest fallback (wizard mode posts availability before any
      // initialState).
      function getManifestProviderIds() {
        var manifest = state.providerManifest;
        if (manifest && manifest.providers && manifest.providers.length > 0) {
          return manifest.providers.map(function(p) { return p.id; });
        }
        return Object.keys(state.providerAvailability || {});
      }

      // Thinking render shape for an agent ('streamed' | 'complete-blocks' |
      // 'none'); undefined when the manifest has no entry for the id.
      function getThinkingStyle(providerId) {
        var entry = getManifestEntry(providerId);
        if (!entry || !entry.capabilities) return undefined;
        return entry.capabilities.thinkingStyle || 'none';
      }

      // Resolve a manifest entry's logo to a webview URI, honoring
      // theme-aware logos (entry.iconDark in dark themes).
      function getEntryLogo(entry) {
        if (!entry) return '';
        if (entry.themeAwareLogo && entry.iconDark && isDarkTheme()) {
          return LOGO_BY_ICON_PATH[entry.iconDark] || LOGO_BY_ICON_PATH[entry.icon] || '';
        }
        return LOGO_BY_ICON_PATH[entry.icon] || '';
      }

      function getAgentLogo(agentId) {
        return getEntryLogo(getManifestEntry(agentId));
      }

      function getAgentShortId(agentId) {
        var entry = getManifestEntry(agentId);
        return entry ? entry.shortId : agentId;
      }

      // Display identity bundle with safe fallbacks for unknown ids /
      // pre-manifest renders (shape matches the old AGENT_DISPLAY entries).
      function getAgentDisplay(agentId) {
        var entry = getManifestEntry(agentId);
        if (entry) {
          return { name: entry.displayName, shortId: entry.shortId, color: entry.color, logo: getEntryLogo(entry) };
        }
        return { name: agentId, shortId: agentId, color: '#888', logo: '' };
      }

      // W10: brainstorm default pair = first two manifest providers.
      function defaultBrainstormPair() {
        return getManifestProviderIds().slice(0, 2);
      }

      // ========================================================================
      // @-Mention system functions
      // ========================================================================

      // Reverse map: shortId -> providerId (rebuilt from the manifest by
      // applyProviderManifest).
      var MENTION_SHORT_MAP = {};
      function rebuildMentionShortMap() {
        MENTION_SHORT_MAP = {};
        var manifest = state.providerManifest;
        var providers = (manifest && manifest.providers) || [];
        providers.forEach(function(p) {
          MENTION_SHORT_MAP[p.shortId] = p.id;
        });
      }

      // ========================================================================
      // Manifest-driven UI builders (Plan 02 Phase 2 — W4/W9/W10)
      // ========================================================================

      function manifestFingerprint() {
        var manifest = state.providerManifest;
        var providers = (manifest && manifest.providers) || [];
        return providers.map(function(p) {
          return p.id + '|' + p.displayName + '|' + p.color;
        }).join(',');
      }

      // W9: settings "Agent" dropdown options come from the manifest; only
      // the brainstorm pseudo-agent is appended statically.
      function renderProviderSelectOptions() {
        if (!providerSelect) return;
        var manifest = state.providerManifest;
        var providers = (manifest && manifest.providers) || [];
        if (providers.length === 0) return; // keep bootstrap markup until the manifest arrives
        var fingerprint = manifestFingerprint();
        if (providerSelect.dataset.manifestFingerprint === fingerprint) return;
        providerSelect.dataset.manifestFingerprint = fingerprint;
        var html = providers.map(function(p) {
          return '<option value="' + p.id + '">' + escapeHtml(p.displayName) + '</option>';
        }).join('');
        html += '<option value="brainstorm">Brainstorm</option>';
        providerSelect.innerHTML = html;
        var desired = (state.settings && state.settings.provider) || (state.activeAgent !== 'brainstorm' ? state.activeAgent : null);
        if (desired) providerSelect.value = desired;
      }

      // W9/W10: brainstorm agent checkboxes come from the manifest.
      function renderBrainstormAgentOptions() {
        var selector = document.getElementById('brainstorm-agent-selector');
        if (!selector) return;
        var manifest = state.providerManifest;
        var providers = (manifest && manifest.providers) || [];
        if (providers.length === 0) return;
        var fingerprint = manifestFingerprint();
        if (selector.dataset.manifestFingerprint === fingerprint) return;
        selector.dataset.manifestFingerprint = fingerprint;
        selector.innerHTML = providers.map(function(p) {
          return '<label class="brainstorm-agent-option" data-agent="' + p.id + '">' +
            '<input type="checkbox" name="brainstorm-agent" value="' + p.id + '" />' +
            '<span class="brainstorm-agent-chip">' +
              '<span class="brainstorm-agent-dot" style="background: ' + p.color + ';"></span>' +
              '<span class="brainstorm-agent-name">' + escapeHtml(p.displayName) + '</span>' +
            '</span>' +
          '</label>';
        }).join('');
        // Re-bind the live NodeList + change handlers (the old nodes are gone)
        brainstormAgentCheckboxes = document.querySelectorAll('input[name="brainstorm-agent"]');
        brainstormAgentCheckboxes.forEach(function(cb) {
          cb.addEventListener('change', updateBrainstormAgentSelection);
        });
        if (state.brainstormAgents) {
          updateBrainstormAgentsUI();
        }
      }

      // W4: declarative provider settings sections (replaces the hard-coded
      // codexSettingsSection). Renders each manifest settingsSections item;
      // values come from state.providerSettings keyed by settingKey, writes
      // go through updateSettings with the settingKey as payload key.
      function renderProviderSettingsSections(providerId) {
        var container = document.getElementById('provider-settings-sections');
        if (!container) return;
        container.innerHTML = '';
        var entry = getManifestEntry(providerId);
        var sections = (entry && entry.settingsSections) || [];
        sections.forEach(function(section) {
          var wrap = document.createElement('div');
          wrap.className = 'settings-section';
          var label = document.createElement('label');
          label.className = 'settings-label';
          label.textContent = section.label || section.id;
          wrap.appendChild(label);

          if (section.type === 'note') {
            var note = document.createElement('div');
            note.className = 'settings-hint';
            note.textContent = section.description || '';
            wrap.appendChild(note);
            container.appendChild(wrap);
            return;
          }

          // The extension only persists keys it ships values for (today:
          // codexProfile). Until the extension exposes a value for this
          // settingKey, render read-only and point at VS Code settings —
          // never a control whose writes silently vanish.
          var persistable = !!(section.settingKey && state.providerSettings &&
            Object.prototype.hasOwnProperty.call(state.providerSettings, section.settingKey));
          var savedValue = persistable ? (state.providerSettings[section.settingKey] || '') : '';

          var control;
          if (section.type === 'select') {
            control = document.createElement('select');
            control.className = 'select';
            (section.options || []).forEach(function(opt) {
              var o = document.createElement('option');
              o.value = opt.value;
              o.textContent = opt.label;
              control.appendChild(o);
            });
            if (savedValue) control.value = savedValue;
          } else {
            control = document.createElement('input');
            control.type = section.type === 'number' ? 'number' : 'text';
            control.className = 'input';
            if (section.placeholder) control.placeholder = section.placeholder;
            control.value = savedValue;
            control.maxLength = 256;
          }

          var errorEl = document.createElement('div');
          errorEl.className = 'settings-hint';
          errorEl.style.color = 'var(--vscode-errorForeground)';
          errorEl.style.display = 'none';

          if (persistable) {
            control.addEventListener('change', function() {
              var raw = (control.value || '').trim();
              var value = (section.type === 'number' && raw !== '') ? Number(raw) : raw;
              if (section.type === 'number' && raw !== '' && isNaN(value)) {
                control.style.borderColor = 'var(--vscode-errorForeground)';
                errorEl.textContent = 'Must be a number';
                errorEl.style.display = 'block';
                return;
              }
              control.style.borderColor = '';
              errorEl.style.display = 'none';
              state.providerSettings[section.settingKey] = value;
              var payload = {};
              payload[section.settingKey] = value;
              postMessageWithPanelId({ type: 'updateSettings', payload: payload });
            });
          } else {
            control.disabled = true;
            control.title = 'Set "mysti.' + (section.settingKey || '') + '" in VS Code Settings';
          }

          wrap.appendChild(control);
          wrap.appendChild(errorEl);

          var hintText = section.description || '';
          if (!persistable && section.settingKey) {
            hintText = (hintText ? hintText + ' ' : '') + 'Configure via VS Code settings: mysti.' + section.settingKey + '.';
          }
          if (hintText) {
            var hint = document.createElement('div');
            hint.className = 'settings-hint';
            hint.textContent = hintText;
            wrap.appendChild(hint);
          }
          container.appendChild(wrap);
        });
      }

      // Apply a (new) manifest to every manifest-derived UI surface.
      function applyProviderManifest() {
        rebuildMentionShortMap();
        renderProviderSelectOptions();
        renderBrainstormAgentOptions();
      }

      // Fuzzy match scorer: returns a score (higher = better) or -1 for no match.
      // Prefers: starts-with > word-boundary match > contains > fuzzy character match
      function fuzzyScore(text, query) {
        if (!query) return 100; // Empty query matches everything
        var t = text.toLowerCase();
        var q = query.toLowerCase();

        // Exact match
        if (t === q) return 1000;
        // Starts with query
        if (t.indexOf(q) === 0) return 500 + (100 - t.length);
        // Contains query as substring
        if (t.indexOf(q) !== -1) return 200 + (100 - t.indexOf(q));

        // Fuzzy: every character in query appears in order in text
        var ti = 0;
        var qi = 0;
        var consecutiveBonus = 0;
        var score = 0;
        while (ti < t.length && qi < q.length) {
          if (t[ti] === q[qi]) {
            score += 10 + consecutiveBonus;
            consecutiveBonus += 5; // Bonus for consecutive matches
            qi++;
          } else {
            consecutiveBonus = 0;
          }
          ti++;
        }

        // All query chars consumed = match
        if (qi === q.length) return score;
        return -1; // No match
      }

      // Highlight matched characters in a display name
      function highlightMatch(text, query) {
        if (!query) return text;
        var t = text.toLowerCase();
        var q = query.toLowerCase();

        // Try substring highlight first
        var idx = t.indexOf(q);
        if (idx !== -1) {
          return text.substring(0, idx)
            + '<strong>' + text.substring(idx, idx + q.length) + '</strong>'
            + text.substring(idx + q.length);
        }

        // Fuzzy highlight: bold each matching character
        var result = '';
        var qi = 0;
        var i;
        for (i = 0; i < text.length; i++) {
          if (qi < q.length && text[i].toLowerCase() === q[qi]) {
            result += '<strong>' + text[i] + '</strong>';
            qi++;
          } else {
            result += text[i];
          }
        }
        return result;
      }

      function showMentionMenu(query) {
        var mentionMenu = document.getElementById('mention-menu');
        var agentsList = document.getElementById('mention-agents-list');
        var filesList = document.getElementById('mention-files-list');
        var filesHeader = document.getElementById('mention-files-header');
        var agentsHeader = mentionMenu ? mentionMenu.querySelector('.mention-menu-header') : null;
        if (!mentionMenu || !agentsList || !filesList) return;

        // Build and score agent items (from the provider manifest)
        var scoredAgents = [];
        var manifestProviders = (state.providerManifest && state.providerManifest.providers) || [];
        manifestProviders.forEach(function(entry) {
          // Score against display name, short name, and full id
          var bestScore = Math.max(
            fuzzyScore(entry.displayName, query),
            fuzzyScore(entry.shortId, query),
            fuzzyScore(entry.id, query)
          );
          if (bestScore >= 0) {
            scoredAgents.push({
              type: 'agent',
              value: entry.id,
              displayName: entry.displayName,
              shortName: entry.shortId,
              logo: getEntryLogo(entry),
              score: bestScore
            });
          }
        });
        // Sort agents by score descending
        scoredAgents.sort(function(a, b) { return b.score - a.score; });

        // Build and score file items
        var scoredFiles = [];
        var fileCache = state.workspaceFileCache || [];
        for (var fi = 0; fi < fileCache.length; fi++) {
          var filePath = fileCache[fi];
          var parts = filePath.replace(/\\/g, '/').split('/');
          var fileName = parts[parts.length - 1] || filePath;
          // Make a relative path for display
          var relativePath = makeRelativePath(filePath) || fileName;

          // Score against filename (primary) and relative path (secondary)
          var fileScore = Math.max(
            fuzzyScore(fileName, query) * 2, // Weight filename higher
            fuzzyScore(relativePath, query)
          );

          if (fileScore >= 0) {
            scoredFiles.push({
              type: 'file',
              value: filePath,
              displayName: fileName,
              shortName: fileName,
              relativePath: relativePath,
              logo: null,
              score: fileScore
            });
          }
        }
        // Sort files by score descending, take top 10
        scoredFiles.sort(function(a, b) { return b.score - a.score; });
        var topFiles = scoredFiles.slice(0, 10);

        state.mentionItems = scoredAgents.concat(topFiles);
        state.mentionMenuIndex = 0;

        // Render agents section
        if (agentsHeader) {
          agentsHeader.style.display = scoredAgents.length > 0 ? '' : 'none';
        }
        agentsList.innerHTML = scoredAgents.map(function(item, idx) {
          var logoHtml = item.logo
            ? '<img class="mention-icon" data-agent-logo="' + item.value + '" src="' + item.logo + '" alt="" />'
            : '<span class="mention-file-icon">' + (item.shortName ? item.shortName[0].toUpperCase() : '?') + '</span>';
          var nameHtml = highlightMatch(item.displayName, query);
          return '<div class="mention-menu-item' + (idx === state.mentionMenuIndex ? ' selected' : '') + '" data-index="' + idx + '" data-type="agent" data-value="' + item.value + '">'
            + logoHtml
            + '<span class="mention-name">' + nameHtml + '</span>'
            + '<span class="mention-shortname">@' + item.shortName + '</span>'
            + '</div>';
        }).join('');

        // Render files section
        var agentCount = scoredAgents.length;
        if (filesHeader) {
          filesHeader.style.display = topFiles.length > 0 ? '' : 'none';
        }
        filesList.innerHTML = topFiles.map(function(item, idx) {
          var globalIdx = agentCount + idx;
          var nameHtml = highlightMatch(item.displayName, query);
          var pathHtml = item.relativePath !== item.displayName
            ? '<span class="mention-shortname" title="' + item.relativePath + '">' + item.relativePath + '</span>'
            : '';
          return '<div class="mention-menu-item' + (globalIdx === state.mentionMenuIndex ? ' selected' : '') + '" data-index="' + globalIdx + '" data-type="file" data-value="' + item.value + '">'
            + '<span class="mention-file-icon">&#128196;</span>'
            + '<span class="mention-name">' + nameHtml + '</span>'
            + pathHtml
            + '</div>';
        }).join('');

        if (state.mentionItems.length > 0) {
          mentionMenu.classList.remove('hidden');
          state.mentionMenuVisible = true;

          // Position the menu above the input area using fixed positioning
          var inputArea = document.querySelector('.input-area');
          if (inputArea) {
            var rect = inputArea.getBoundingClientRect();
            mentionMenu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
          }
        } else {
          hideMentionMenu();
        }

        // Add click handlers
        mentionMenu.querySelectorAll('.mention-menu-item').forEach(function(el) {
          el.addEventListener('click', function() {
            var idx = parseInt(el.dataset.index, 10);
            if (state.mentionItems[idx]) {
              insertMention(state.mentionItems[idx]);
            }
          });
        });
      }

      function hideMentionMenu() {
        var mentionMenu = document.getElementById('mention-menu');
        if (mentionMenu) {
          mentionMenu.classList.add('hidden');
        }
        state.mentionMenuVisible = false;
        state.mentionQuery = null;
      }

      function insertMention(item) {
        var inputEl = document.getElementById('message-input');
        if (!inputEl) return;

        var before = inputEl.value.substring(0, state.mentionStartPos);
        var after = inputEl.value.substring(inputEl.selectionStart);
        var mentionText = '@' + item.shortName + ' ';

        inputEl.value = before + mentionText + after;
        var newPos = state.mentionStartPos + mentionText.length;
        inputEl.selectionStart = newPos;
        inputEl.selectionEnd = newPos;

        hideMentionMenu();
        inputEl.focus();
      }

      function parseMentionsFromContent(content) {
        var mentions = [];
        // M3: Refined regex — allows alphanumeric, hyphens, dots, slashes, underscores
        var regex = /@([\w\-.\/]+)/g;
        var match;
        while ((match = regex.exec(content)) !== null) {
          var word = match[1].toLowerCase();
          // M5: Check if it's a known agent shortname (not just any string)
          if (MENTION_SHORT_MAP[word]) {
            mentions.push({
              type: 'agent',
              value: MENTION_SHORT_MAP[word],
              displayName: '@' + word,
              startIndex: match.index,
              endIndex: match.index + match[0].length
            });
          } else {
            // M4: File matching with path boundary check — require minimum 3 chars
            // and match on path separator boundary or exact filename
            if (word.length < 3) continue;
            var matchedFile = null;
            var files = state.workspaceFileCache || [];
            for (var i = 0; i < files.length; i++) {
              var normalized = files[i].replace(/\\/g, '/');
              var parts = normalized.split('/');
              var fileName = (parts[parts.length - 1] || '').toLowerCase();
              // Exact full path, exact filename, OR path ending with /word
              if (normalized.toLowerCase() === word || fileName === word || normalized.toLowerCase().endsWith('/' + word)) {
                matchedFile = files[i];
                break;
              }
            }
            if (matchedFile) {
              mentions.push({
                type: 'file',
                value: matchedFile,
                displayName: '@' + word,
                startIndex: match.index,
                endIndex: match.index + match[0].length
              });
            }
          }
        }
        return mentions;
      }

      // Sub-agent card rendering
      function handleSubAgentStarted(payload) {
        var agentId = payload.agentId;
        var agentInfo = getAgentDisplay(agentId);
        var logoSrc = agentInfo.logo;
        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        var card = document.createElement('div');
        card.className = 'subagent-card';
        card.id = 'subagent-' + getAgentShortId(agentId);

        var logoHtml = logoSrc
          ? '<img src="' + logoSrc + '" alt="" class="subagent-logo" data-agent-logo="' + agentId + '" />'
          : '<span style="font-size:18px;">' + (agentInfo.shortId ? agentInfo.shortId[0].toUpperCase() : '?') + '</span>';

        card.innerHTML =
          '<div class="subagent-header">'
          + logoHtml
          + '<span class="subagent-name">' + agentInfo.name + ' (sub-agent)</span>'
          + '<span class="subagent-status streaming">Working...</span>'
          + '<span class="subagent-collapse-icon">&#9660;</span>'
          + '</div>'
          + '<div class="subagent-content" id="subagent-content-' + getAgentShortId(agentId) + '"></div>';

        messagesEl.appendChild(card);

        // Attach click handler via addEventListener (CSP-safe — inline onclick is blocked by nonce-based CSP)
        var headerEl = card.querySelector('.subagent-header');
        if (headerEl) {
          headerEl.addEventListener('click', function() {
            card.classList.toggle('collapsed');
          });
        }

        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // handleSubAgentExtracting removed — task descriptions come from the task list now

      // Track raw text per sub-agent for throttled markdown rendering
      var subagentRawText = {};
      var subagentRenderTimers = {};

      function handleSubAgentChunk(payload) {
        var agentId = payload.agentId;
        var shortId = getAgentShortId(agentId);
        var contentEl = document.getElementById('subagent-content-' + shortId);
        if (!contentEl) return;

        // Update status to show streaming is active
        var card = document.getElementById('subagent-' + shortId);
        if (card) {
          var statusEl = card.querySelector('.subagent-status');
          if (statusEl && statusEl.textContent !== 'Streaming...') {
            statusEl.textContent = 'Streaming...';
          }
        }

        if (payload.chunkType === 'text' && payload.content) {
          // Accumulate raw text
          if (!subagentRawText[shortId]) { subagentRawText[shortId] = ''; }
          subagentRawText[shortId] += payload.content;

          // Get or create the text output area
          var textEl = contentEl.querySelector('.subagent-text-output');
          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'subagent-text-output';
            contentEl.appendChild(textEl);
          }

          // Throttled markdown rendering (every 200ms)
          if (!subagentRenderTimers[shortId]) {
            subagentRenderTimers[shortId] = setTimeout(function() {
              subagentRenderTimers[shortId] = null;
              var el = contentEl.querySelector('.subagent-text-output');
              if (el && subagentRawText[shortId] && typeof marked !== 'undefined') {
                try {
                  el.innerHTML = marked.parse(subagentRawText[shortId]);
                  el.className = 'subagent-text-output rendered';
                  setTimeout(function() {
                    if (typeof Prism !== 'undefined') {
                      Prism.highlightAllUnder(el);
                    }
                  }, 0);
                } catch (e) {
                  el.textContent = subagentRawText[shortId];
                }
              }
            }, 200);
          }
        } else if (payload.chunkType === 'thinking' && payload.content) {
          // Get or create the thinking section
          var thinkingEl = contentEl.querySelector('.subagent-thinking');
          if (!thinkingEl) {
            thinkingEl = document.createElement('div');
            thinkingEl.className = 'subagent-thinking';
            thinkingEl.innerHTML = '<div class="subagent-thinking-label">Thinking</div><div class="subagent-thinking-text"></div>';
            contentEl.insertBefore(thinkingEl, contentEl.firstChild);
          }
          var thinkingText = thinkingEl.querySelector('.subagent-thinking-text');
          if (thinkingText) {
            thinkingText.textContent += payload.content;
          }
        }

        // Scroll to bottom
        var messagesEl = document.getElementById('messages');
        if (messagesEl) { messagesEl.scrollTop = messagesEl.scrollHeight; }
      }

      function handleSubAgentComplete(payload) {
        var agentId = payload.agentId;
        var shortId = getAgentShortId(agentId);
        var card = document.getElementById('subagent-' + shortId);
        if (!card) return;

        var statusEl = card.querySelector('.subagent-status');
        if (statusEl) {
          if (payload.hasError) {
            statusEl.textContent = 'Partial';
            statusEl.className = 'subagent-status error';
          } else {
            statusEl.textContent = 'Done';
            statusEl.className = 'subagent-status complete';
          }
        }

        // Clear any pending render timer
        if (subagentRenderTimers[shortId]) {
          clearTimeout(subagentRenderTimers[shortId]);
          subagentRenderTimers[shortId] = null;
        }

        // Final markdown render with full syntax highlighting
        var contentEl = document.getElementById('subagent-content-' + shortId);
        if (contentEl && typeof marked !== 'undefined') {
          var textEl = contentEl.querySelector('.subagent-text-output');
          var rawText = subagentRawText[shortId] || (textEl ? textEl.textContent : '') || '';
          if (textEl && rawText) {
            try {
              textEl.innerHTML = marked.parse(rawText);
              textEl.className = 'subagent-text-output rendered';
              setTimeout(function() {
                if (typeof Prism !== 'undefined') {
                  Prism.highlightAllUnder(textEl);
                }
                if (typeof renderMermaidDiagrams === 'function') {
                  renderMermaidDiagrams();
                }
              }, 0);
            } catch (e) {
              // Keep plain text on parse error
            }
          }

          // Add expand/collapse button if content overflows
          if (contentEl.scrollHeight > 400) {
            var existingBtn = contentEl.querySelector('.subagent-expand-btn');
            if (!existingBtn) {
              var expandBtn = document.createElement('button');
              expandBtn.className = 'subagent-expand-btn';
              expandBtn.textContent = 'Show full output';
              expandBtn.addEventListener('click', function() {
                card.classList.toggle('expanded');
                expandBtn.textContent = card.classList.contains('expanded') ? 'Show less' : 'Show full output';
              });
              contentEl.appendChild(expandBtn);
            }
          }
        }

        // Clean up raw text tracking
        delete subagentRawText[shortId];
      }

      function handleSubAgentError(payload) {
        var agentId = payload.agentId;
        var card = document.getElementById('subagent-' + getAgentShortId(agentId));
        if (!card) return;

        var statusEl = card.querySelector('.subagent-status');
        if (statusEl) {
          statusEl.textContent = 'Error';
          statusEl.className = 'subagent-status error';
        }

        var contentEl = document.getElementById('subagent-content-' + getAgentShortId(agentId));
        if (contentEl) {
          contentEl.innerHTML =
            '<div class="subagent-error-content">' +
              '<span class="subagent-error-text">Error: ' + escapeHtml(payload.error || 'Unknown error') + '</span>' +
              '<button class="subagent-retry-btn">Retry</button>' +
            '</div>';

          var retryBtn = contentEl.querySelector('.subagent-retry-btn');
          if (retryBtn) {
            retryBtn.addEventListener('click', function() {
              postMessageWithPanelId({
                type: 'retrySubAgent',
                payload: { agentId: agentId }
              });
            });
          }
        }
      }

      function handleSubAgentToolUse(payload) {
        var agentId = payload.agentId;
        var toolCall = payload.toolCall;
        if (!toolCall) return;
        var contentEl = document.getElementById('subagent-content-' + getAgentShortId(agentId));
        if (!contentEl) return;

        // Update status badge to show tool execution
        var card = document.getElementById('subagent-' + getAgentShortId(agentId));
        if (card) {
          var statusEl = card.querySelector('.subagent-status');
          if (statusEl) {
            statusEl.textContent = 'Tool: ' + toolCall.name;
          }
        }

        // Create expandable tool call indicator inside the sub-agent card
        var toolDiv = document.createElement('div');
        toolDiv.className = 'subagent-tool-call running';
        toolDiv.dataset.id = toolCall.id;

        // Build a short summary of the tool input
        var summary = '';
        if (toolCall.input) {
          if (toolCall.input.file_path || toolCall.input.path) {
            summary = (toolCall.input.file_path || toolCall.input.path);
          } else if (toolCall.input.command) {
            summary = toolCall.input.command;
          } else if (toolCall.input.pattern) {
            summary = toolCall.input.pattern;
          } else {
            var keys = Object.keys(toolCall.input);
            if (keys.length > 0) {
              var firstVal = String(toolCall.input[keys[0]]);
              summary = firstVal.length > 60 ? firstVal.substring(0, 60) + '...' : firstVal;
            }
          }
        }

        // Format tool input as syntax-highlighted JSON
        var inputJson = '';
        try {
          inputJson = JSON.stringify(toolCall.input || {}, null, 2);
        } catch (e) {
          inputJson = String(toolCall.input || '{}');
        }

        toolDiv.innerHTML =
          '<div class="subagent-tool-header">' +
            '<span class="subagent-tool-spinner"></span>' +
            '<span class="subagent-tool-name">' + escapeHtml(toolCall.name) + '</span>' +
            '<span class="subagent-tool-summary">' + escapeHtml(summary) + '</span>' +
            '<span class="subagent-tool-toggle">&#9656;</span>' +
          '</div>' +
          '<div class="subagent-tool-detail">' +
            '<div class="subagent-tool-detail-section">' +
              '<span class="subagent-tool-detail-label">Input</span>' +
              '<pre class="subagent-tool-detail-code"><code class="language-json">' + escapeHtml(inputJson) + '</code></pre>' +
            '</div>' +
            '<div class="subagent-tool-detail-section subagent-tool-output" style="display:none;">' +
              '<span class="subagent-tool-detail-label">Output</span>' +
              '<pre class="subagent-tool-detail-code"><code class="subagent-tool-output-code"></code></pre>' +
            '</div>' +
          '</div>';

        // Click header to toggle detail panel
        var header = toolDiv.querySelector('.subagent-tool-header');
        if (header) {
          header.addEventListener('click', function() {
            toolDiv.classList.toggle('detail-open');
            var toggle = toolDiv.querySelector('.subagent-tool-toggle');
            if (toggle) {
              toggle.innerHTML = toolDiv.classList.contains('detail-open') ? '&#9662;' : '&#9656;';
            }
            // Highlight JSON on first open
            if (toolDiv.classList.contains('detail-open') && typeof Prism !== 'undefined') {
              Prism.highlightAllUnder(toolDiv);
            }
          });
        }

        contentEl.appendChild(toolDiv);
        var messagesEl = document.getElementById('messages');
        if (messagesEl) { messagesEl.scrollTop = messagesEl.scrollHeight; }
      }

      function handleSubAgentToolResult(payload) {
        var agentId = payload.agentId;
        var toolCall = payload.toolCall;
        if (!toolCall) return;
        var contentEl = document.getElementById('subagent-content-' + getAgentShortId(agentId));
        if (!contentEl) return;

        var toolDiv = contentEl.querySelector('.subagent-tool-call[data-id="' + toolCall.id + '"]');
        if (toolDiv) {
          toolDiv.classList.remove('running');
          var resultStatus = (toolCall.status === 'failed') ? 'failed' : 'completed';
          toolDiv.classList.add(resultStatus);
          // Replace spinner with check/x icon
          var spinner = toolDiv.querySelector('.subagent-tool-spinner');
          if (spinner) {
            spinner.outerHTML = resultStatus === 'failed'
              ? '<span class="subagent-tool-icon failed">&#10005;</span>'
              : '<span class="subagent-tool-icon completed">&#10003;</span>';
          }

          // Populate output section if result content available
          var outputSection = toolDiv.querySelector('.subagent-tool-output');
          var outputCode = toolDiv.querySelector('.subagent-tool-output-code');
          if (outputSection && outputCode && toolCall.output) {
            var outputText = typeof toolCall.output === 'string'
              ? toolCall.output
              : JSON.stringify(toolCall.output, null, 2);
            // Truncate very long outputs
            if (outputText.length > 2000) {
              outputText = outputText.substring(0, 2000) + '\n... (truncated)';
            }
            outputCode.textContent = outputText;
            outputSection.style.display = '';
            // Re-highlight if detail panel is already open
            if (toolDiv.classList.contains('detail-open') && typeof Prism !== 'undefined') {
              Prism.highlightAllUnder(toolDiv);
            }
          }
        }

        // Update status back to streaming
        var card = document.getElementById('subagent-' + getAgentShortId(agentId));
        if (card) {
          var statusEl = card.querySelector('.subagent-status');
          if (statusEl) { statusEl.textContent = 'Streaming...'; }
        }
      }

      function handleSubAgentRetry(payload) {
        var agentId = payload.agentId;
        var card = document.getElementById('subagent-' + getAgentShortId(agentId));
        if (!card) return;

        var statusEl = card.querySelector('.subagent-status');
        if (statusEl) {
          statusEl.textContent = 'Retrying...';
          statusEl.className = 'subagent-status retrying';
        }

        // Clear content for the new attempt
        var contentEl = document.getElementById('subagent-content-' + getAgentShortId(agentId));
        if (contentEl) {
          contentEl.innerHTML = '';
        }
      }

      function handleSubAgentAskUserQuestion(payload) {
        var agentId = payload.agentId;
        var questionData = payload.questionData;
        if (!agentId || !questionData) return;

        var shortId = getAgentShortId(agentId);
        var contentEl = document.getElementById('subagent-content-' + shortId);
        if (!contentEl) return;

        // Update status to "Waiting for answer..."
        var card = document.getElementById('subagent-' + shortId);
        if (card) {
          var statusEl = card.querySelector('.subagent-status');
          if (statusEl) {
            statusEl.textContent = 'Waiting for answer...';
            statusEl.className = 'subagent-status';
          }
        }

        // Render the question UI inside the sub-agent card (reuse existing renderer)
        var container = renderAskUserQuestionTabs(questionData.toolCallId, questionData.questions);
        if (!container) return;

        // Override submit handler to send sub-agent-specific message
        var submitBtn = container.querySelector('.auq-submit-btn');
        if (submitBtn) {
          submitBtn.onclick = function() {
            container.classList.add('submitted');
            postMessageWithPanelId({
              type: 'subAgentQuestionResponse',
              payload: {
                toolCallId: questionData.toolCallId,
                agentId: agentId,
                answers: container._answers
              }
            });
            container.innerHTML = '<div class="auq-submitted"><span class="auq-check">✓</span> Answers submitted</div>';
            // Update status back to working
            if (card) {
              var sEl = card.querySelector('.subagent-status');
              if (sEl) {
                sEl.textContent = 'Working...';
                sEl.className = 'subagent-status streaming';
              }
            }
            setTimeout(function() { container.remove(); }, 1500);
          };
        }

        // Override skip handler to send sub-agent-specific skip
        var skipBtn = container.querySelector('.auq-skip-btn');
        if (skipBtn) {
          skipBtn.onclick = function() {
            postMessageWithPanelId({
              type: 'subAgentQuestionSkipped',
              payload: {
                toolCallId: questionData.toolCallId,
                agentId: agentId
              }
            });
            container.remove();
          };
        }

        contentEl.appendChild(container);
        var messagesEl = document.getElementById('messages');
        if (messagesEl) { messagesEl.scrollTop = messagesEl.scrollHeight; }
      }

      function handleSubAgentStatus(payload) {
        var agentId = payload.agentId;
        var status = payload.status;
        if (!agentId) return;

        var card = document.getElementById('subagent-' + getAgentShortId(agentId));
        if (!card) return;

        var statusEl = card.querySelector('.subagent-status');
        if (statusEl) {
          statusEl.textContent = status || 'Working...';
          statusEl.className = 'subagent-status' + (status === 'Working...' ? ' streaming' : '');
        }
      }

      function handleMentionTaskListGenerated(payload) {
        var tasks = payload.tasks || [];
        if (tasks.length === 0) return;

        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        var banner = document.createElement('div');
        banner.className = 'mention-task-list';
        banner.id = 'mention-task-list-banner';

        var label = document.createElement('span');
        label.className = 'mention-task-label';
        label.textContent = 'Tasks:';
        banner.appendChild(label);

        tasks.forEach(function(task, index) {
          if (index > 0) {
            var arrow = document.createElement('span');
            arrow.className = 'mention-task-arrow';
            arrow.textContent = '→';
            banner.appendChild(arrow);
          }

          var agentInfo = getAgentDisplay(task.agent);
          var pill = document.createElement('span');
          pill.className = 'mention-task-pill pending';
          pill.id = 'mention-task-pill-' + index;

          var taskDesc = task.taskType === 'switch'
            ? 'Switch provider'
            : (task.task && task.task.length > 30 ? task.task.substring(0, 30) + '...' : (task.task || ''));

          pill.innerHTML =
            '<span class="mention-task-order">' + (index + 1) + '</span>' +
            '<span class="mention-task-agent">' + escapeHtml(agentInfo.name) + '</span>' +
            '<span class="mention-task-desc">' + escapeHtml(taskDesc) + '</span>';

          banner.appendChild(pill);
        });

        messagesEl.appendChild(banner);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function handleMentionTaskStarted(payload) {
        var pill = document.getElementById('mention-task-pill-' + payload.taskIndex);
        if (pill) {
          pill.className = 'mention-task-pill running';
        }
      }

      function handleMentionTaskComplete(payload) {
        var pill = document.getElementById('mention-task-pill-' + payload.taskIndex);
        if (pill) {
          pill.className = payload.hasError
            ? 'mention-task-pill error'
            : 'mention-task-pill done';
        }
      }

      // ========================================================================

      // Dismiss the init loading overlay with a fade animation
      function dismissInitLoading() {
        var overlay = document.getElementById('init-loading-overlay');
        if (overlay && !overlay.classList.contains('hidden')) {
          overlay.classList.add('fade-out');
          setTimeout(function() { overlay.classList.add('hidden'); }, 300);
        }
      }

      // First-run safety net: initialState/showWizard normally dismiss the
      // overlay within a moment. If neither arrives (e.g. a stalled extension
      // probe), force-dismiss after 12s so the UI is never permanently stuck on
      // "Preparing your workspace…" — background follow-ups still populate it.
      setTimeout(dismissInitLoading, 12000);

      // Helper to send messages with panelId
      function postMessageWithPanelId(msg) {
        msg.panelId = state.panelId;
        vscode.postMessage(msg);
      }

      // ========================================================================
      // Perf instrumentation (Plan 03 Phase 1) — gated by the
      // mysti.debug.performanceLogging setting, delivered via the initialState
      // payload (payload.performanceLogging). When disabled, the per-chunk
      // cost in handleResponseChunk is a single boolean check — no
      // allocations, no timers, no ring buffer. Coarse signals (uiReady,
      // firstChunkRendered) are posted regardless of the flag so the
      // extension's always-on coarse measures (panel.timeToUsable,
      // send.ttftRender) keep working.
      // ========================================================================

      var PERF_SAMPLE_BUFFER_CAP = 2000;
      var perfState = {
        enabled: false,
        samples: null,    // ring buffer (allocated lazily on first sample)
        index: 0,         // next write position
        count: 0,         // valid entries (<= PERF_SAMPLE_BUFFER_CAP)
        chunkCount: 0,    // chunks handled during the current response
        heapTimer: null,  // 60s heap sampling interval id
        uiReadySent: false
      };

      // Enable/disable the harness. Heap is sampled immediately on enable
      // (the "init" sample), then every 60s while enabled. Disabling clears
      // the interval (the only teardown path this webview has — there is no
      // unload handler; VS Code destroys the whole JS context on dispose)
      // and drops the ring buffer.
      function perfSetEnabled(on) {
        on = !!on;
        if (on === perfState.enabled) return;
        perfState.enabled = on;
        if (on) {
          perfPostHeapSample();
          if (!perfState.heapTimer) {
            perfState.heapTimer = setInterval(perfPostHeapSample, 60000);
          }
        } else {
          if (perfState.heapTimer) {
            clearInterval(perfState.heapTimer);
            perfState.heapTimer = null;
          }
          perfState.samples = null;
          perfState.index = 0;
          perfState.count = 0;
          perfState.chunkCount = 0;
        }
      }

      // Record one handleResponseChunk body duration into the ring buffer.
      // Only called when perfState.enabled is true.
      function perfRecordChunk(ms) {
        if (!perfState.samples) perfState.samples = [];
        perfState.samples[perfState.index] = ms;
        perfState.index = (perfState.index + 1) % PERF_SAMPLE_BUFFER_CAP;
        if (perfState.count < PERF_SAMPLE_BUFFER_CAP) perfState.count++;
        perfState.chunkCount++;
      }

      // Nearest-rank percentile over an ascending-sorted array. Mirrors
      // PerfTracker.percentile on the extension side (p clamped to [0,100],
      // idx = min(n-1, max(0, ceil(p/100*n)-1))).
      function perfPercentile(sortedAscending, p) {
        var n = sortedAscending.length;
        if (n === 0) return 0;
        var clamped = Math.min(100, Math.max(0, p));
        var rank = Math.ceil((clamped / 100) * n) - 1;
        var idx = Math.min(n - 1, Math.max(0, rank));
        return sortedAscending[idx];
      }

      // Chromium-only API in the webview; undefined elsewhere.
      function perfHeapUsed() {
        return (typeof performance !== 'undefined' && performance.memory)
          ? performance.memory.usedJSHeapSize
          : undefined;
      }

      // Per-response summary posted on responseComplete (only when enabled).
      function perfBuildReport() {
        var sorted = perfState.samples
          ? perfState.samples.slice(0, perfState.count).sort(function(a, b) { return a - b; })
          : [];
        return {
          type: 'perfReport',
          reason: 'done',
          chunkCount: perfState.chunkCount,
          p50: perfPercentile(sorted, 50),
          p95: perfPercentile(sorted, 95),
          max: sorted.length ? sorted[sorted.length - 1] : 0,
          heapUsed: perfHeapUsed()
        };
      }

      // Heap-only report (enable-time init sample + 60s interval).
      function perfPostHeapSample() {
        var heap = perfHeapUsed();
        if (typeof heap === 'number') {
          postMessageWithPanelId({ type: 'perfReport', reason: 'heap', heapUsed: heap });
        }
      }

      // Coarse send.ttftRender round-trip: posted in the rAF after the first
      // text chunk of a response painted, regardless of the enabled flag.
      function perfPostFirstChunkRendered(sentAt) {
        requestAnimationFrame(function() {
          postMessageWithPanelId({ type: 'perfMark', name: 'firstChunkRendered', sentAt: sentAt });
        });
      }

      // Coarse panel.timeToUsable: posted once, in the rAF after the initial
      // initialState render, regardless of the enabled flag.
      function perfPostUiReady() {
        if (perfState.uiReadySent) return;
        perfState.uiReadySent = true;
        requestAnimationFrame(function() {
          postMessageWithPanelId({ type: 'uiReady' });
        });
      }

      // Helper to convert absolute paths to relative paths
      function makeRelativePath(absolutePath) {
        if (!absolutePath || !state.workspacePath) return absolutePath;
        // Normalize path separators
        var normalizedPath = absolutePath.replace(/\\/g, '/');
        var normalizedWorkspace = state.workspacePath.replace(/\\/g, '/');
        // Remove workspace prefix if present
        if (normalizedPath.startsWith(normalizedWorkspace)) {
          var relative = normalizedPath.substring(normalizedWorkspace.length);
          // Remove leading slash
          return relative.startsWith('/') ? relative.substring(1) : relative;
        }
        return absolutePath;
      }

      // Helper to replace absolute paths with relative paths in a string (for commands)
      function cleanPathsInString(str) {
        if (!str || !state.workspacePath) return str;
        var normalizedWorkspace = state.workspacePath.replace(/\\/g, '/');
        // Replace workspace path with ./ or just remove it
        return str.split(normalizedWorkspace + '/').join('')
                  .split(normalizedWorkspace).join('.');
      }

      // Autocomplete variables
      var autocompleteDebounceTimer = null;
      var tabHoldStart = 0;
      var tabHoldTimer = null;
      var currentCompletionLevel = 'sentence'; // Track current level during hold

      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('message-input');
      const autocompleteGhostEl = document.getElementById('autocomplete-ghost');
      const sendBtn = document.getElementById('send-btn');
      const stopBtn = document.getElementById('stop-btn');
      const settingsBtn = document.getElementById('settings-btn');
      const settingsPanel = document.getElementById('settings-panel');
      const aboutBtn = document.getElementById('about-btn');
      const aboutPanel = document.getElementById('about-panel');
      const badgesBtn = document.getElementById('badges-btn');
      const badgesPanel = document.getElementById('badges-panel');
      const newConversationBtn = document.getElementById('new-conversation-btn');
      const newTabBtn = document.getElementById('new-tab-btn');
      const modeSelect = document.getElementById('mode-select');
      const thinkingSelect = document.getElementById('thinking-select');
      const modelSelect = document.getElementById('model-select');
      const customModelSection = document.getElementById('custom-model-section');
      const customModelInput = document.getElementById('custom-model-input');
      const customModelError = document.getElementById('custom-model-error');
      const providerSelect = document.getElementById('provider-select');
      const accessSelect = document.getElementById('access-select');
      const contextModeBtn = document.getElementById('context-mode-btn');
      const contextModeLabel = document.getElementById('context-mode-label');
      const addContextBtn = document.getElementById('add-context-btn');
      const clearContextBtn = document.getElementById('clear-context-btn');
      const contextItems = document.getElementById('context-items');
      const slashCmdBtn = document.getElementById('slash-cmd-btn');
      const slashMenu = document.getElementById('slash-menu');
      const enhanceBtn = document.getElementById('enhance-btn');
      const behaviorIndicator = document.getElementById('behavior-indicator');
      const behaviorPopup = document.getElementById('behavior-popup');
      const sessionIndicator = document.getElementById('session-indicator');
      const stopAgentBtn = document.getElementById('stop-agent-btn');
      const agentSelectBtn = document.getElementById('agent-select-btn');
      const agentMenu = document.getElementById('agent-menu');
      const historyBtn = document.getElementById('history-btn');
      const historyMenu = document.getElementById('history-menu');

      // Welcome screen suggestions with auto-persona and skills configuration
      var WELCOME_SUGGESTIONS = [
  {
    "id": "understand",
    "title": "Understand Project",
    "description": "Analyze structure, patterns & conventions",
    "messages": [
      {
        "provider": "claude",
        "message": "/init"
      },
      {
        "provider": "codex",
        "message": "Analyze this codebase thoroughly. Map the directory structure, identify the tech stack and frameworks, understand the architecture patterns in use, locate entry points, and document key conventions. Summarize: project purpose, main components, data flow, dependencies, and any configuration patterns. Create a mental model I can reference for future tasks."
      }
    ],
    "icon": "magnifier",
    "color": "blue",
    "suggestedPersona": "architect",
    "suggestedSkills": ["organized", "repo-hygiene", "first-principles", "doc-reflexes"]
  },
  {
    "id": "review",
    "title": "Code Review",
    "description": "Find bugs, anti-patterns & improvements",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a comprehensive code review. Identify bugs, logic errors, anti-patterns, code smells, and potential edge cases. Suggest specific improvements for readability, maintainability, and adherence to best practices. Prioritize findings by severity and provide actionable fixes."
      },
      {
        "provider": "codex",
        "message": "Perform a comprehensive code review. Identify bugs, logic errors, anti-patterns, code smells, and potential edge cases. Suggest specific improvements for readability, maintainability, and adherence to best practices. Prioritize findings by severity (critical/high/medium/low) and provide actionable fixes with code examples."
      }
    ],
    "icon": "eye",
    "color": "purple",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["scope-discipline", "doc-reflexes", "first-principles", "test-driven", "organized"]
  },
  {
    "id": "cleanup",
    "title": "Clean Up",
    "description": "Remove dead code, reorganize files & enforce hygiene",
    "messages": [
      {
        "provider": "claude",
        "message": "Deep clean this codebase. Find and remove: dead code, unused imports, orphaned files, redundant dependencies, commented-out code blocks, and empty or placeholder files. Reorganize file structure for clarity—group related modules, enforce consistent naming conventions, and suggest files to merge, split, or relocate. Clean up package.json/requirements.txt of unused dependencies. Provide a summary of all removals and reorganizations."
      },
      {
        "provider": "codex",
        "message": "Deep clean this codebase. Find and remove: dead code, unused imports, orphaned files, redundant dependencies, commented-out code blocks, and empty or placeholder files. Reorganize file structure for clarity—group related modules, enforce consistent naming conventions, and identify files to merge, split, or relocate. Clean up package.json/requirements.txt of unused dependencies. Execute the cleanup and provide a summary of all changes made."
      }
    ],
    "icon": "brush",
    "color": "green",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["repo-hygiene", "organized", "scope-discipline", "auto-commit"]
  },
  {
    "id": "tests",
    "title": "Write Tests",
    "description": "Add comprehensive test coverage",
    "messages": [
      {
        "provider": "claude",
        "message": "Analyze test coverage gaps and write tests. Identify critical untested paths, edge cases, and error conditions. Create unit tests for individual functions, integration tests for component interactions, and suggest e2e test scenarios. Follow existing test patterns and conventions. Prioritize tests by risk—focus on business-critical logic, data transformations, and error handling first."
      },
      {
        "provider": "codex",
        "message": "Analyze test coverage gaps and write tests. Identify critical untested paths, edge cases, and error conditions. Create unit tests for individual functions, integration tests for component interactions. Follow existing test patterns and conventions in this repo. Prioritize tests by risk—focus on business-critical logic, data transformations, and error handling first. Write and save the test files."
      }
    ],
    "icon": "lab",
    "color": "teal",
    "suggestedPersona": "debugger",
    "suggestedSkills": ["test-driven", "scope-discipline", "organized", "first-principles"]
  },
  {
    "id": "security",
    "title": "Security Audit",
    "description": "Find vulnerabilities, secrets & attack vectors",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a thorough security audit. Check for: exposed secrets, API keys, and credentials in code or config files; injection vulnerabilities (SQL, XSS, command injection); insecure dependencies with known CVEs; authentication and authorization flaws; OWASP Top 10 issues; insecure data handling and storage; missing input validation and sanitization; improper error messages that leak information. Prioritize findings by severity (critical/high/medium/low) with specific remediation steps."
      },
      {
        "provider": "codex",
        "message": "Perform a thorough security audit. Check for: exposed secrets, API keys, and credentials in code or config files; injection vulnerabilities (SQL, XSS, command injection); insecure dependencies with known CVEs; authentication and authorization flaws; OWASP Top 10 issues; insecure data handling and storage; missing input validation and sanitization; improper error messages that leak information. Prioritize findings by severity (critical/high/medium/low) with specific remediation steps. Fix critical issues immediately."
      }
    ],
    "icon": "lock",
    "color": "red",
    "suggestedPersona": "security",
    "suggestedSkills": ["first-principles", "scope-discipline", "doc-reflexes", "organized", "dependency-aware"]
  },
  {
    "id": "performance",
    "title": "Performance",
    "description": "Identify bottlenecks & optimize resources",
    "messages": [
      {
        "provider": "claude",
        "message": "Analyze performance and identify optimization opportunities. Look for: N+1 queries and database inefficiencies; unnecessary re-renders or computations; missing caching opportunities; memory leaks and resource cleanup issues; blocking operations that should be async; large bundle sizes and lazy-loading candidates; inefficient algorithms and data structures; slow regex or string operations. Provide specific fixes with expected impact and any trade-offs."
      },
      {
        "provider": "codex",
        "message": "Analyze performance and identify optimization opportunities. Look for: N+1 queries and database inefficiencies; unnecessary re-renders or computations; missing caching opportunities; memory leaks and resource cleanup issues; blocking operations that should be async; large bundle sizes and lazy-loading candidates; inefficient algorithms and data structures; slow regex or string operations. Implement fixes and document expected impact and any trade-offs for each change."
      }
    ],
    "icon": "flash",
    "color": "amber",
    "suggestedPersona": "performance",
    "suggestedSkills": ["first-principles", "test-driven", "scope-discipline", "organized"]
  },
  {
    "id": "docs",
    "title": "Documentation",
    "description": "Add docs, comments & usage examples",
    "messages": [
      {
        "provider": "claude",
        "message": "Improve project documentation comprehensively. Add or update: JSDoc/docstrings for all public APIs with parameter types and return values; inline comments explaining complex or non-obvious logic; README with setup instructions, usage examples, and architecture overview; API documentation with request/response examples; environment variable documentation; contribution guidelines if missing. Focus on explaining 'why' not just 'what'."
      },
      {
        "provider": "codex",
        "message": "Improve project documentation comprehensively. Add or update: JSDoc/docstrings for all public APIs with parameter types and return values; inline comments explaining complex or non-obvious logic; README with setup instructions, usage examples, and architecture overview; API documentation with request/response examples; environment variable documentation; contribution guidelines if missing. Focus on explaining 'why' not just 'what'. Write all documentation files."
      }
    ],
    "icon": "notes",
    "color": "indigo",
    "suggestedPersona": "mentor",
    "suggestedSkills": ["doc-reflexes", "organized", "concise", "first-principles"]
  },
  {
    "id": "refactor",
    "title": "Refactor",
    "description": "Improve architecture & eliminate code smells",
    "messages": [
      {
        "provider": "claude",
        "message": "Identify refactoring opportunities to improve code quality. Find: code duplication that should be abstracted; overly complex functions that need decomposition; tight coupling that reduces testability; violated SOLID principles; mixed concerns that should be separated; inconsistent patterns across the codebase; magic numbers and hardcoded values; poor naming that obscures intent. Propose specific refactoring strategies with before/after examples. Prioritize by impact and risk."
      },
      {
        "provider": "codex",
        "message": "Identify and execute refactoring to improve code quality. Find and fix: code duplication that should be abstracted; overly complex functions that need decomposition; tight coupling that reduces testability; violated SOLID principles; mixed concerns that should be separated; inconsistent patterns across the codebase; magic numbers and hardcoded values; poor naming that obscures intent. Implement refactoring changes incrementally, committing after each logical improvement. Prioritize by impact and risk."
      }
    ],
    "icon": "recycle",
    "color": "orange",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["first-principles", "scope-discipline", "test-driven", "organized", "repo-hygiene"]
  },
  {
    "id": "production",
    "title": "Production Ready",
    "description": "Harden for reliability & operability",
    "messages": [
      {
        "provider": "claude",
        "message": "Audit production readiness and harden the codebase. Check and improve: error handling—ensure all errors are caught, logged, and handled gracefully; logging—add structured logging for debugging and monitoring; environment configuration—separate configs for dev/staging/prod with proper secret management; health checks and readiness probes; graceful shutdown handling; rate limiting and request validation; retry logic with exponential backoff for external calls; database connection pooling and timeout handling; feature flags for safe rollouts. Create a checklist of items to address before deployment."
      },
      {
        "provider": "codex",
        "message": "Audit production readiness and harden the codebase. Check and improve: error handling—ensure all errors are caught, logged, and handled gracefully; logging—add structured logging for debugging and monitoring; environment configuration—separate configs for dev/staging/prod with proper secret management; health checks and readiness probes; graceful shutdown handling; rate limiting and request validation; retry logic with exponential backoff for external calls; database connection pooling and timeout handling. Implement missing production hardening. Create a PRODUCTION_CHECKLIST.md with status of each item."
      }
    ],
    "icon": "rocket",
    "color": "green",
    "suggestedPersona": "devops",
    "suggestedSkills": ["graceful-degradation", "rollback-ready", "test-driven", "doc-reflexes", "dependency-aware"]
  },
  {
    "id": "deploy",
    "title": "Prep Deployment",
    "description": "Set up CI/CD, containers & infrastructure",
    "messages": [
      {
        "provider": "claude",
        "message": "Prepare deployment infrastructure and automation. Set up or improve: CI/CD pipeline with build, test, lint, and deploy stages; Dockerfile with multi-stage builds, minimal base images, and security best practices; docker-compose for local development parity; environment-specific configuration management; automated testing gates before deployment; deployment scripts with rollback capability; infrastructure as code if applicable; secrets management integration; build caching for faster pipelines. Document the deployment process."
      },
      {
        "provider": "codex",
        "message": "Prepare deployment infrastructure and automation. Create or improve: CI/CD pipeline with build, test, lint, and deploy stages; Dockerfile with multi-stage builds, minimal base images, and security best practices; docker-compose for local development parity; environment-specific configuration management; automated testing gates before deployment; deployment scripts with rollback capability; build caching for faster pipelines. Write all configuration files and create a DEPLOYMENT.md with the complete deployment process."
      }
    ],
    "icon": "package",
    "color": "purple",
    "suggestedPersona": "devops",
    "suggestedSkills": ["auto-commit", "rollback-ready", "organized", "doc-reflexes", "dependency-aware"]
  },
  {
    "id": "compliance",
    "title": "Compliance",
    "description": "Audit licenses, accessibility & regulations",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a compliance audit across multiple dimensions. Check: dependency licenses for compatibility and legal requirements (GPL, MIT, Apache, etc.); license file presence and accuracy; accessibility compliance (WCAG 2.1 for web apps); data privacy requirements (GDPR, CCPA handling); audit logging for regulated industries; required security headers and policies; third-party data sharing and tracking disclosures; terms of service requirements for external APIs. Generate a compliance report with findings and required actions."
      },
      {
        "provider": "codex",
        "message": "Perform a compliance audit across multiple dimensions. Check: dependency licenses for compatibility and legal requirements (GPL, MIT, Apache, etc.); license file presence and accuracy; accessibility compliance (WCAG 2.1 for web apps); data privacy requirements (GDPR, CCPA handling); audit logging for regulated industries; required security headers and policies; third-party data sharing and tracking disclosures; terms of service requirements for external APIs. Generate a COMPLIANCE_REPORT.md with findings, severity, and required remediation actions."
      }
    ],
    "icon": "check",
    "color": "blue",
    "suggestedPersona": "security",
    "suggestedSkills": ["doc-reflexes", "scope-discipline", "organized", "first-principles", "dependency-aware"]
  },
  {
    "id": "debug",
    "title": "Debug Issue",
    "description": "Diagnose root cause & trace execution",
    "messages": [
      {
        "provider": "claude",
        "message": "Help me systematically debug an issue. I will describe the problem—expected vs actual behavior, error messages, and steps to reproduce. Then help me: trace the execution path to isolate the failure point; identify potential root causes from most to least likely; suggest diagnostic steps (logging, breakpoints, test cases) to confirm the cause; propose fixes with explanation of why they address the root cause, not just symptoms; recommend preventive measures to avoid similar issues."
      },
      {
        "provider": "codex",
        "message": "Help me systematically debug an issue. I will describe the problem—expected vs actual behavior, error messages, and steps to reproduce. Then: trace the execution path to isolate the failure point; identify potential root causes from most to least likely; add diagnostic logging if needed to confirm the cause; implement the fix that addresses the root cause, not just symptoms; add a regression test to prevent recurrence; commit with a detailed explanation of the bug and fix."
      }
    ],
    "icon": "bug",
    "color": "red",
    "suggestedPersona": "debugger",
    "suggestedSkills": ["first-principles", "test-driven", "scope-discipline", "organized", "concise"]
  }
];

      // Helper to get provider-specific message from suggestion.
      // W8: suggestion data may key messages by full provider id OR by the
      // manifest shortId (legacy payloads) — match both via the manifest
      // instead of a hard-coded alias map.
      function getProviderMessage(suggestion, currentProvider) {
        // New format: messages array with provider-specific entries
        if (suggestion.messages && Array.isArray(suggestion.messages)) {
          var entry = getManifestEntry(currentProvider);
          var shortId = entry ? entry.shortId : currentProvider;
          var found = suggestion.messages.find(function(m) {
            return m.provider === currentProvider || m.provider === shortId;
          });
          if (found) return found.message;
          // Fallback to first message if provider not found
          return suggestion.messages[0] ? suggestion.messages[0].message : '';
        }
        // Backward compatibility: single message field
        return suggestion.message || '';
      }

      function renderWelcomeSuggestions() {
        var container = document.getElementById('welcome-suggestions');
        if (!container) return;
        container.innerHTML = '';

        WELCOME_SUGGESTIONS.forEach(function(s) {
          var card = document.createElement('button');
          card.className = 'welcome-card';
          card.setAttribute('data-color', s.color);

          // Get provider-specific message for tooltip
          var providerMsg = getProviderMessage(s, state.settings.provider);
          card.title = providerMsg;

          card.innerHTML =
            '<div class="welcome-card-icon"><img src="' + ICON_URIS[s.icon] + '" alt="" loading="lazy" /></div>' +
            '<div class="welcome-card-title">' + escapeHtml(s.title) + '</div>' +
            '<div class="welcome-card-desc">' + escapeHtml(s.description) + '</div>';

          card.onclick = function() {
            // Get provider-specific message at click time (provider may have changed)
            var message = getProviderMessage(s, state.settings.provider);
            // Send with suggested persona and skills for auto-configuration
            postMessageWithPanelId({
              type: 'quickActionWithConfig',
              payload: {
                content: message,
                context: state.context,
                settings: state.settings,
                suggestedPersona: s.suggestedPersona || null,
                suggestedSkills: s.suggestedSkills || []
              }
            });
          };

          container.appendChild(card);
        });
      }

      // Render welcome suggestions on load
      renderWelcomeSuggestions();

      // Debug logging
      console.log('[Mysti Webview] Setting up event listeners...');
      console.log('[Mysti Webview] sendBtn:', sendBtn);
      console.log('[Mysti Webview] inputEl:', inputEl);

      if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
      } else {
        console.error('[Mysti Webview] sendBtn not found!');
      }

      var attachBtn = document.getElementById('attach-btn');
      if (attachBtn) {
        attachBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'requestFileAttachment' });
        });
      }
      if (stopBtn) {
        stopBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'cancelRequest' });
        });
      }
      if (stopAgentBtn) {
        stopAgentBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          postMessageWithPanelId({ type: 'shutdownAgent', payload: { force: false } });
        });
      }
      if (inputEl) {
        inputEl.addEventListener('keydown', function(e) {
        // Slash menu keyboard navigation (highest priority when visible)
        if (state.slashMenuVisible) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            state.slashMenuIndex = Math.min(state.slashMenuIndex + 1, state.slashMenuItems.length - 1);
            updateSlashMenuSelection();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            state.slashMenuIndex = Math.max(state.slashMenuIndex - 1, 0);
            updateSlashMenuSelection();
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            if (state.slashMenuItems.length > 0) {
              e.preventDefault();
              executeSlashMenuItem(state.slashMenuItems[state.slashMenuIndex]);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashMenu();
            inputEl.value = '';
            inputEl.style.height = 'auto';
            return;
          }
          // Let other keys fall through (typing filters the menu via input handler)
        }

        // @-mention keyboard navigation (takes priority when menu is visible)
        if (state.mentionMenuVisible) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            state.mentionMenuIndex = Math.min(state.mentionMenuIndex + 1, state.mentionItems.length - 1);
            showMentionMenu(state.mentionQuery || '');
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            state.mentionMenuIndex = Math.max(state.mentionMenuIndex - 1, 0);
            showMentionMenu(state.mentionQuery || '');
            return;
          }
          if (e.key === 'Tab' || e.key === 'Enter') {
            if (state.mentionItems.length > 0) {
              e.preventDefault();
              insertMention(state.mentionItems[state.mentionMenuIndex]);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            hideMentionMenu();
            return;
          }
        }

        // Tab key handling for autocomplete (hold-duration based)
        if (e.key === 'Tab' && state.autocompleteSuggestion) {
          e.preventDefault();

          // Only start hold tracking on first keydown (not repeat)
          if (!tabHoldStart) {
            tabHoldStart = Date.now();
            currentCompletionLevel = 'sentence';

            // Accept sentence completion immediately
            acceptAutocomplete();

            // Set up progressive completion while holding
            tabHoldTimer = setInterval(function() {
              var holdDuration = Date.now() - tabHoldStart;

              if (holdDuration > 600 && currentCompletionLevel !== 'message') {
                // After 600ms, upgrade to message completion
                currentCompletionLevel = 'message';
                postMessageWithPanelId({
                  type: 'requestAutocomplete',
                  payload: { text: inputEl.value, type: 'message' }
                });
                // Stop checking after message level
                if (tabHoldTimer) {
                  clearInterval(tabHoldTimer);
                  tabHoldTimer = null;
                }
              } else if (holdDuration > 300 && currentCompletionLevel === 'sentence') {
                // After 300ms, upgrade to paragraph completion
                currentCompletionLevel = 'paragraph';
                postMessageWithPanelId({
                  type: 'requestAutocomplete',
                  payload: { text: inputEl.value, type: 'paragraph' }
                });
              }
            }, 50); // Check every 50ms for responsive feel
          }
          return;
        }

        // Escape to dismiss autocomplete
        if (e.key === 'Escape' && state.autocompleteSuggestion) {
          clearAutocomplete();
          return;
        }

        // Escape to stop a request in flight (Claude-Code-style interrupt).
        // Runs after menu/autocomplete dismissal so it only fires when nothing
        // else is consuming Escape.
        if (e.key === 'Escape' && state.isLoading) {
          e.preventDefault();
          postMessageWithPanelId({ type: 'cancelRequest' });
          return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          clearAutocomplete();
          sendMessage();
        }
        if (e.key === '/' && inputEl.value === '') {
          e.preventDefault();
          inputEl.value = '/';
          showSlashMenu('');
        }
        });

        // Tab key release handler
        inputEl.addEventListener('keyup', function(e) {
          if (e.key === 'Tab') {
            tabHoldStart = 0;
            if (tabHoldTimer) {
              clearInterval(tabHoldTimer);
              tabHoldTimer = null;
            }
            currentCompletionLevel = 'sentence';
          }
        });

        // Paste handler for images and files
        inputEl.addEventListener('paste', function(e) {
          var clipboardData = e.clipboardData;
          if (!clipboardData || !clipboardData.items) return;

          for (var i = 0; i < clipboardData.items.length; i++) {
            var item = clipboardData.items[i];
            if (item.kind !== 'file') continue;

            var isImage = item.type.startsWith('image/');
            var blob = item.getAsFile();
            if (!blob) continue;

            e.preventDefault();

            var sizeLimit = isImage ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
            var sizeLimitLabel = isImage ? '5 MB' : '10 MB';

            if (blob.size > sizeLimit) {
              showToast('File too large (max ' + sizeLimitLabel + ')', 'error');
              continue;
            }

            if (state.attachments.length >= 10) {
              showToast('Maximum 10 attachments per message', 'error');
              continue;
            }

            (function(b, bIsImage) {
              var reader = new FileReader();
              reader.onload = function(evt) {
                var dataUrl = evt.target.result;
                var base64 = dataUrl.split(',')[1];
                var mimeType = dataUrl.split(';')[0].split(':')[1] || b.type || 'application/octet-stream';
                var fileName = b.name || (bIsImage ? 'pasted-image.' + (mimeType.split('/')[1] || 'png') : 'pasted-file');
                var attachment = {
                  id: 'att-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                  type: bIsImage ? 'image' : 'file',
                  fileName: fileName,
                  mimeType: mimeType,
                  base64Data: base64,
                  size: b.size
                };
                state.attachments.push(attachment);
                renderAttachmentPreviews();
              };
              reader.readAsDataURL(b);
            })(blob, isImage);
          }
        });

        // Document-level drag and drop (must capture at document level to
        // prevent VSCode from intercepting the drop and opening the file)
        var dropOverlay = document.getElementById('drop-overlay');
        var dragCounter = 0; // Track nested drag enter/leave events

        document.addEventListener('dragenter', function(e) {
          e.preventDefault();
          e.stopPropagation();
          dragCounter++;
          if (dragCounter === 1 && dropOverlay) {
            dropOverlay.classList.add('visible');
          }
        });

        document.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.stopPropagation();
        });

        document.addEventListener('dragleave', function(e) {
          e.preventDefault();
          e.stopPropagation();
          dragCounter--;
          if (dragCounter <= 0) {
            dragCounter = 0;
            if (dropOverlay) {
              dropOverlay.classList.remove('visible');
            }
          }
        });

        document.addEventListener('drop', function(e) {
          e.preventDefault();
          e.stopPropagation();
          dragCounter = 0;
          if (dropOverlay) {
            dropOverlay.classList.remove('visible');
          }
          handleDroppedFiles(e.dataTransfer);
        });

        inputEl.addEventListener('input', function() {
        autoResizeTextarea();

        // Slash menu filtering: if input starts with '/', show/update menu; otherwise hide
        if (inputEl.value.startsWith('/')) {
          var slashQuery = inputEl.value.slice(1); // Remove leading '/'
          showSlashMenu(slashQuery);
        } else if (state.slashMenuVisible) {
          hideSlashMenu();
        }

        // @-mention detection
        var cursorPos = inputEl.selectionStart;
        var textBeforeCursor = inputEl.value.substring(0, cursorPos);
        var mentionMatch = textBeforeCursor.match(/@(\S*)$/);

        if (mentionMatch) {
          state.mentionQuery = mentionMatch[1].toLowerCase();
          state.mentionStartPos = cursorPos - mentionMatch[0].length;
          showMentionMenu(state.mentionQuery);
        } else {
          hideMentionMenu();
        }

        // Clear current autocomplete when typing
        clearAutocomplete();

        // Debounce autocomplete request (300ms)
        if (autocompleteDebounceTimer) {
          clearTimeout(autocompleteDebounceTimer);
        }
        autocompleteDebounceTimer = setTimeout(function() {
          var text = inputEl.value.trim();
          if (text && text.length > 3 && !text.startsWith('/') && !state.isLoading) {
            // Request precompute for instant response when Tab is held
            postMessageWithPanelId({
              type: 'requestAutocomplete',
              payload: { text: inputEl.value, type: 'sentence', precompute: true }
            });
          }
        }, 300);

        // Debounce recommendation request (500ms) - only if auto-suggest enabled
        if (window.recommendationDebounceTimer) {
          clearTimeout(window.recommendationDebounceTimer);
        }
        if (state.agentSettings && state.agentSettings.autoSuggest) {
          window.recommendationDebounceTimer = setTimeout(function() {
            var text = inputEl.value.trim();
            if (text && text.length > 10 && !text.startsWith('/')) {
              postMessageWithPanelId({
                type: 'getAgentRecommendations',
                payload: { query: text }
              });
            }
          }, 500);
        }
        });
      } else {
        console.error('[Mysti Webview] inputEl not found!');
      }

      // Global keydown handler for permission cards and AUQ
      document.addEventListener('keydown', function(e) {
        // Skip if typing in an input/textarea
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
          return;
        }

        // Permission card shortcuts (1/2/3, Enter, Esc)
        if (handlePermissionKeyboard(e)) {
          return;
        }

        // AUQ number key shortcuts (1-9 to select options)
        var auqContainer = document.querySelector('.ask-user-question-container:not(.submitted)');
        if (auqContainer && e.key >= '1' && e.key <= '9') {
          var optNum = parseInt(e.key);
          var activePanel = auqContainer.querySelector('.auq-panel[style*="display: block"], .auq-panel:first-child');
          if (activePanel) {
            var targetOption = activePanel.querySelector('.auq-option[data-option-num="' + optNum + '"] input');
            if (targetOption) {
              e.preventDefault();
              targetOption.checked = !targetOption.checked;
              targetOption.dispatchEvent(new Event('change'));
            }
          }
        }

        // Enter to submit AUQ
        if (auqContainer && e.key === 'Enter' && !e.shiftKey) {
          var submitBtn = auqContainer.querySelector('.auq-submit-btn:not(:disabled)');
          if (submitBtn) {
            e.preventDefault();
            submitBtn.click();
          }
        }
      });

      settingsBtn.addEventListener('click', function() {
        settingsPanel.classList.toggle('hidden');
        // Close other panels when settings opens
        var agentConfigPanel = document.getElementById('agent-config-panel');
        if (!settingsPanel.classList.contains('hidden')) {
          if (agentConfigPanel) { agentConfigPanel.classList.add('hidden'); }
          if (aboutPanel) { aboutPanel.classList.add('hidden'); }
          if (badgesPanel) { badgesPanel.classList.add('hidden'); }
        }
      });

      // About panel toggle
      if (aboutBtn && aboutPanel) {
        aboutBtn.addEventListener('click', function() {
          aboutPanel.classList.toggle('hidden');
          // Close other panels when about opens
          if (!aboutPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            if (badgesPanel) { badgesPanel.classList.add('hidden'); }
            var agentConfigPanel = document.getElementById('agent-config-panel');
            if (agentConfigPanel) { agentConfigPanel.classList.add('hidden'); }
          }
        });
      }

      // Badges panel toggle
      if (badgesBtn && badgesPanel) {
        badgesBtn.addEventListener('click', function() {
          badgesPanel.classList.toggle('hidden');
          // Close other panels when badges opens
          if (!badgesPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            if (aboutPanel) { aboutPanel.classList.add('hidden'); }
            var agentConfigPanel = document.getElementById('agent-config-panel');
            if (agentConfigPanel) { agentConfigPanel.classList.add('hidden'); }
            // Render instantly from cache, then refresh in background
            if (cachedBadges && cachedBadgeCounts) {
              updateBadgesUI(cachedBadges, cachedBadgeCounts);
            } else {
              // Show spinner while waiting for data
              var sp = document.getElementById('badges-spinner');
              if (sp) { sp.classList.remove('hidden'); }
            }
            vscode.postMessage({ type: 'requestBadges' });
          }
        });
      }

      // Agent config panel toggle
      var agentConfigBtn = document.getElementById('agent-config-btn');
      var agentConfigPanel = document.getElementById('agent-config-panel');
      var configResetBtn = document.getElementById('config-reset-btn');

      if (agentConfigBtn && agentConfigPanel) {
        agentConfigBtn.addEventListener('click', function() {
          agentConfigPanel.classList.toggle('hidden');
          // Close other panels when config opens
          if (!agentConfigPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            if (aboutPanel) { aboutPanel.classList.add('hidden'); }
            if (badgesPanel) { badgesPanel.classList.add('hidden'); }
          }
        });
      }

      // Reset agent config
      if (configResetBtn) {
        configResetBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          state.agentConfig = { personaId: null, enabledSkills: [] };
          renderAgentConfigPanel();
          saveAgentConfig();
        });
      }

      // Map persona ID to icon key for ICON_URIS
      function getPersonaIconKey(personaId) {
        var mapping = {
          'architect': 'architecture',
          'prototyper': 'rocket',
          'product-centric': 'package',
          'refactorer': 'recycle',
          'devops': 'gear',
          'domain-expert': 'target',
          'researcher': 'microscope',
          'builder': 'hammer',
          'debugger': 'bug',
          'integrator': 'chain',
          'mentor': 'teacher',
          'designer': 'paint',
          'fullstack': 'globe',
          'security': 'lock',
          'performance': 'flash',
          'toolsmith': 'tools'
        };
        return mapping[personaId] || personaId;
      }

      // Render agent config panel
      function renderAgentConfigPanel() {
        var personaGrid = document.getElementById('persona-grid');
        var skillsList = document.getElementById('skills-list');

        if (!personaGrid || !skillsList) return;

        // Render personas
        personaGrid.innerHTML = '';
        state.availablePersonas.forEach(function(p) {
          var card = document.createElement('div');
          card.className = 'persona-card' + (state.agentConfig.personaId === p.id ? ' selected' : '');
          card.dataset.persona = p.id;
          card.title = p.description;
          card.innerHTML =
            '<span class="persona-card-icon"><img src="' + ICON_URIS[getPersonaIconKey(p.id)] + '" alt="" loading="lazy" /></span>' +
            '<span class="persona-card-name">' + escapeHtml(p.name) + '</span>';

          card.onclick = function() {
            togglePersona(p.id);
          };

          personaGrid.appendChild(card);
        });

        // Render skills
        skillsList.innerHTML = '';
        state.availableSkills.forEach(function(s) {
          var isActive = state.agentConfig.enabledSkills.indexOf(s.id) !== -1;
          var item = document.createElement('div');
          item.className = 'skill-item' + (isActive ? ' active' : '');
          item.dataset.skill = s.id;
          item.title = s.description;
          item.innerHTML =
            '<div class="skill-toggle"></div>' +
            '<span class="skill-name">' + escapeHtml(s.name) + '</span>';

          item.onclick = function() {
            toggleSkill(s.id);
          };

          skillsList.appendChild(item);
        });

        updateConfigSummary();
      }

      // Render agent recommendations from auto-suggest (compact inline widget)
      function renderRecommendations(payload) {
        var widget = document.getElementById('inline-suggestions');
        var chipsContainer = document.getElementById('inline-suggestions-chips');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');

        if (!widget || !chipsContainer) return;

        // Hide if no recommendations
        if (!payload.recommendations || payload.recommendations.length === 0) {
          widget.classList.add('hidden');
          return;
        }

        // Sync auto-suggest checkbox with current state
        if (autoSuggestCheck) {
          autoSuggestCheck.checked = state.agentSettings && state.agentSettings.autoSuggest;
        }

        // Build compact recommendation chips (show type instead of reason for compactness)
        var chipsHtml = payload.recommendations.map(function(rec) {
          var confidenceClass = rec.confidence + '-confidence';
          var typeLabel = rec.type === 'persona' ? 'persona' : 'skill';
          return '<div class="recommendation-chip ' + confidenceClass + '" ' +
                 'data-agent-id="' + rec.agent.id + '" ' +
                 'data-agent-type="' + rec.type + '" ' +
                 'title="' + escapeHtml(rec.reason) + '">' +
                 '<span class="chip-name">' + escapeHtml(rec.agent.name) + '</span>' +
                 '<span class="chip-type">' + typeLabel + '</span>' +
                 '</div>';
        }).join('');

        chipsContainer.innerHTML = chipsHtml;
        widget.classList.remove('hidden');

        // Add click handlers to chips
        chipsContainer.querySelectorAll('.recommendation-chip').forEach(function(chip) {
          chip.addEventListener('click', function() {
            var agentId = chip.dataset.agentId;
            var agentType = chip.dataset.agentType;

            if (agentType === 'persona') {
              selectPersona(agentId);
            } else if (agentType === 'skill') {
              toggleSkill(agentId);
            }

            // Mark as selected
            chip.classList.add('selected');

            // Hide widget after selection
            setTimeout(function() {
              widget.classList.add('hidden');
            }, 200);
          });
        });
      }

      // Inline suggestions widget handlers
      (function() {
        var dismissBtn = document.getElementById('inline-suggestions-dismiss');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');
        var widget = document.getElementById('inline-suggestions');

        if (dismissBtn) {
          dismissBtn.addEventListener('click', function() {
            if (widget) widget.classList.add('hidden');
          });
        }

        if (autoSuggestCheck) {
          autoSuggestCheck.addEventListener('change', function() {
            var isEnabled = autoSuggestCheck.checked;
            state.agentSettings = state.agentSettings || {};
            state.agentSettings.autoSuggest = isEnabled;

            // Update settings panel toggle if visible
            var settingsToggle = document.getElementById('auto-suggest-toggle');
            if (settingsToggle) {
              settingsToggle.classList.toggle('active', isEnabled);
            }

            // Send to extension
            postMessageWithPanelId({
              type: 'updateSettings',
              payload: { 'agents.autoSuggest': isEnabled }
            });

            // Hide widget if auto-suggest is disabled
            if (!isEnabled && widget) {
              widget.classList.add('hidden');
            }
          });
        }
      })();

      // Toolbar persona button click handler
      (function() {
        var personaBtn = document.getElementById('toolbar-persona-btn');
        if (personaBtn) {
          personaBtn.addEventListener('click', function(e) {
            // Don't open suggestions if clicking the clear button
            if (e.target.closest('.toolbar-persona-clear')) return;

            var widget = document.getElementById('inline-suggestions');
            var inputEl = document.getElementById('message-input');

            if (!widget) return;

            if (widget.classList.contains('hidden')) {
              // Request recommendations based on current input
              var query = inputEl ? inputEl.value.trim() : '';
              if (query.length > 3) {
                postMessageWithPanelId({
                  type: 'getAgentRecommendations',
                  payload: { query: query }
                });
              } else {
                // Show all personas if no meaningful input
                showAllPersonaSuggestions();
              }
            } else {
              widget.classList.add('hidden');
            }
          });
        }
      })();

      // Toolbar persona clear button click handler
      (function() {
        var clearBtn = document.getElementById('toolbar-persona-clear');
        if (clearBtn) {
          clearBtn.addEventListener('click', function(e) {
            e.stopPropagation(); // Prevent triggering parent button click

            // Clear persona selection
            state.agentConfig.personaId = null;

            // Update UI
            document.querySelectorAll('.persona-card').forEach(function(card) {
              card.classList.remove('selected');
            });

            // Hide inline suggestions if visible
            var widget = document.getElementById('inline-suggestions');
            if (widget) widget.classList.add('hidden');

            updateConfigSummary();
            updateToolbarPersonaIndicator();
            saveAgentConfig();
          });
        }
      })();

      function togglePersona(personaId) {
        if (state.agentConfig.personaId === personaId) {
          // Deselect if clicking same persona
          state.agentConfig.personaId = null;
        } else {
          state.agentConfig.personaId = personaId;
        }

        // Update UI
        document.querySelectorAll('.persona-card').forEach(function(card) {
          card.classList.toggle('selected', card.dataset.persona === state.agentConfig.personaId);
        });

        updateConfigSummary();
        updateToolbarPersonaIndicator();
        saveAgentConfig();
      }

      // Select persona (always sets, never toggles) - used by inline suggestions
      function selectPersona(personaId) {
        state.agentConfig.personaId = personaId;

        // Update persona cards UI
        document.querySelectorAll('.persona-card').forEach(function(card) {
          card.classList.toggle('selected', card.dataset.persona === personaId);
        });

        updateConfigSummary();
        updateToolbarPersonaIndicator();
        saveAgentConfig();
      }

      function toggleSkill(skillId) {
        var index = state.agentConfig.enabledSkills.indexOf(skillId);
        if (index === -1) {
          state.agentConfig.enabledSkills.push(skillId);
        } else {
          state.agentConfig.enabledSkills.splice(index, 1);
        }

        // Update UI
        document.querySelectorAll('.skill-item').forEach(function(item) {
          var isActive = state.agentConfig.enabledSkills.indexOf(item.dataset.skill) !== -1;
          item.classList.toggle('active', isActive);
        });

        updateConfigSummary();
        saveAgentConfig();
      }

      function updateConfigSummary() {
        var summaryText = document.getElementById('config-summary-text');
        var configBtn = document.getElementById('agent-config-btn');

        if (!summaryText) return;

        var parts = [];

        if (state.agentConfig.personaId) {
          var persona = state.availablePersonas.find(function(p) { return p.id === state.agentConfig.personaId; });
          if (persona) parts.push(persona.name);
        }

        if (state.agentConfig.enabledSkills.length > 0) {
          parts.push(state.agentConfig.enabledSkills.length + ' skill' +
                     (state.agentConfig.enabledSkills.length > 1 ? 's' : ''));
        }

        if (parts.length === 0) {
          summaryText.textContent = 'Default (no customization)';
          if (configBtn) configBtn.classList.remove('has-config');
        } else {
          summaryText.textContent = parts.join(' + ');
          if (configBtn) configBtn.classList.add('has-config');
        }

        // Also update toolbar persona indicator
        updateToolbarPersonaIndicator();
      }

      // Update toolbar persona indicator button
      function updateToolbarPersonaIndicator() {
        var nameEl = document.getElementById('toolbar-persona-name');
        var btn = document.getElementById('toolbar-persona-btn');
        var clearBtn = document.getElementById('toolbar-persona-clear');
        if (!nameEl || !btn) return;

        if (state.agentConfig.personaId) {
          var persona = state.availablePersonas.find(function(p) {
            return p.id === state.agentConfig.personaId;
          });
          nameEl.textContent = persona ? persona.name : 'Unknown';
          btn.classList.add('has-persona');
          btn.title = 'Active: ' + (persona ? persona.name : 'Unknown') + ' (click to change)';
          if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
          nameEl.textContent = 'No persona';
          btn.classList.remove('has-persona');
          btn.title = 'Click to select a persona';
          if (clearBtn) clearBtn.classList.add('hidden');
        }
      }

      // Show all personas in inline suggestions (when no context query)
      function showAllPersonaSuggestions() {
        var widget = document.getElementById('inline-suggestions');
        var chipsContainer = document.getElementById('inline-suggestions-chips');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');
        if (!widget || !chipsContainer) return;

        // Sync checkbox state
        if (autoSuggestCheck) {
          autoSuggestCheck.checked = state.agentSettings && state.agentSettings.autoSuggest;
        }

        var chipsHtml = state.availablePersonas.map(function(p) {
          var isSelected = state.agentConfig.personaId === p.id;
          return '<div class="recommendation-chip' + (isSelected ? ' selected' : '') + '" ' +
                 'data-agent-id="' + p.id + '" data-agent-type="persona" ' +
                 'title="' + escapeHtml(p.description || '') + '">' +
                 '<span class="chip-name">' + escapeHtml(p.name) + '</span>' +
                 '</div>';
        }).join('');

        chipsContainer.innerHTML = chipsHtml;
        widget.classList.remove('hidden');

        // Add click handlers
        chipsContainer.querySelectorAll('.recommendation-chip').forEach(function(chip) {
          chip.addEventListener('click', function() {
            selectPersona(chip.dataset.agentId);
            widget.classList.add('hidden');
          });
        });
      }

      function saveAgentConfig() {
        // Send to extension for per-conversation persistence
        postMessageWithPanelId({
          type: 'updateAgentConfig',
          payload: state.agentConfig
        });
      }

      newConversationBtn.addEventListener('click', function() {
        postMessageWithPanelId({ type: 'newConversation' });
      });

      newTabBtn.addEventListener('click', function() {
        postMessageWithPanelId({ type: 'openInNewTab' });
      });

      // DeepMyst Connections button (Plan 04)
      var connectionsBtn = document.getElementById('connections-btn');
      if (connectionsBtn) {
        connectionsBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'openConnections' });
        });
      }

      // Export conversation button
      var exportConversationBtn = document.getElementById('export-conversation-btn');
      if (exportConversationBtn) {
        exportConversationBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'exportConversation' });
        });
      }

      // Manual compaction trigger via context usage pie chart click
      var contextUsageEl = document.getElementById('context-usage');
      if (contextUsageEl) {
        contextUsageEl.addEventListener('click', function() {
          // Don't trigger if already compacting
          if (contextUsageEl.classList.contains('compacting')) {
            return;
          }
          // Don't trigger if no usage data yet
          if (!state.contextUsage.usedTokens || state.contextUsage.usedTokens <= 0) {
            return;
          }
          postMessageWithPanelId({ type: 'manualCompact' });
        });
      }

      // History menu toggle
      if (historyBtn && historyMenu) {
        historyBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          historyMenu.classList.toggle('hidden');
          if (!historyMenu.classList.contains('hidden')) {
            postMessageWithPanelId({ type: 'getConversationHistory' });
          }
        });
      }

      // Close history menu on outside click
      document.addEventListener('click', function(e) {
        if (historyMenu && !historyMenu.contains(e.target) && e.target !== historyBtn) {
          historyMenu.classList.add('hidden');
        }
      });

      // CAPTURE PHASE handler for Install buttons - runs before bubbling
      // This ensures clicks work even on buttons inside disabled items
      document.addEventListener('click', function(e) {
        var installBtn = e.target.closest('.agent-install-btn');
        if (installBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var agentId = installBtn.dataset.agent;
          console.log('[Mysti Webview] CAPTURE: Install button clicked for:', agentId);
          if (agentId) {
            try {
              console.log('[Mysti Webview] Calling showInstallProviderModal...');
              showInstallProviderModal(agentId);
              console.log('[Mysti Webview] showInstallProviderModal called successfully');
            } catch (err) {
              console.error('[Mysti Webview] ERROR in showInstallProviderModal:', err);
            }
          } else {
            console.log('[Mysti Webview] No agentId found on button');
          }
        }
      }, true); // true = capture phase

      // Render history menu items
      function renderHistoryMenu(conversations, currentId) {
        if (!historyMenu) return;
        historyMenu.innerHTML = '';

        if (conversations.length === 0) {
          historyMenu.innerHTML = '<div class="history-empty">No previous chats</div>';
          return;
        }

        conversations.forEach(function(conv) {
          var item = document.createElement('div');
          item.className = 'history-item' + (conv.id === currentId ? ' active' : '');

          var date = new Date(conv.updatedAt);
          var dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

          item.innerHTML =
            '<div class="history-item-info">' +
              '<span class="history-item-title">' + escapeHtml(conv.title || 'New Conversation') + '</span>' +
              '<span class="history-item-date">' + dateStr + '</span>' +
            '</div>' +
            '<button class="history-item-delete" title="Delete">×</button>';

          // Click to switch conversation
          item.addEventListener('click', function(e) {
            if (!e.target.classList.contains('history-item-delete')) {
              postMessageWithPanelId({ type: 'switchConversation', payload: { id: conv.id } });
              historyMenu.classList.add('hidden');
            }
          });

          // Delete button
          item.querySelector('.history-item-delete').addEventListener('click', function(e) {
            e.stopPropagation();
            postMessageWithPanelId({ type: 'deleteConversation', payload: { id: conv.id } });
          });

          historyMenu.appendChild(item);
        });
      }

      modeSelect.addEventListener('change', function() {
        state.settings.mode = modeSelect.value;
        updateBehaviorIndicator();
        updateBehaviorHint();
        // Sync popup dropdown
        var popupMode = document.getElementById('popup-mode-select');
        if (popupMode) popupMode.value = modeSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { mode: modeSelect.value } });
      });

      thinkingSelect.addEventListener('change', function() {
        state.settings.thinkingLevel = thinkingSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { thinkingLevel: thinkingSelect.value } });
      });

      modelSelect.addEventListener('change', function() {
        if (modelSelect.value === '__custom__') {
          customModelSection.classList.remove('hidden');
          customModelInput.focus();
        } else {
          customModelSection.classList.add('hidden');
          customModelInput.value = '';
          customModelError.style.display = 'none';
          customModelInput.style.borderColor = '';
          state.settings.model = modelSelect.value;
          postMessageWithPanelId({ type: 'updateSettings', payload: { model: modelSelect.value, customModel: '' } });
        }
      });

      // Custom model input validation
      customModelInput.addEventListener('input', function() {
        var val = customModelInput.value.trim();
        if (val && !/^[a-zA-Z0-9][a-zA-Z0-9._\-:/[\]]*$/.test(val)) {
          customModelInput.style.borderColor = 'var(--vscode-errorForeground)';
          customModelError.textContent = 'Invalid characters. Use letters, numbers, dots, hyphens, underscores, colons, slashes, square brackets.';
          customModelError.style.display = 'block';
        } else if (val && val.length > 128) {
          customModelInput.style.borderColor = 'var(--vscode-errorForeground)';
          customModelError.textContent = 'Too long (max 128 characters)';
          customModelError.style.display = 'block';
        } else {
          customModelInput.style.borderColor = '';
          customModelError.style.display = 'none';
        }
      });

      // Custom model input save on change/blur
      customModelInput.addEventListener('change', function() {
        var val = customModelInput.value.trim();
        if (val && /^[a-zA-Z0-9][a-zA-Z0-9._\-:/[\]]*$/.test(val) && val.length <= 128) {
          postMessageWithPanelId({ type: 'updateSettings', payload: { customModel: val } });
        }
      });

      // W4: provider-specific inputs (Codex profile, endpoints, ...) are
      // rendered + bound by renderProviderSettingsSections from the manifest.

      accessSelect.addEventListener('change', function() {
        state.settings.accessLevel = accessSelect.value;
        updateBehaviorHint();
        // Sync popup dropdown
        var popupAccess = document.getElementById('popup-access-select');
        if (popupAccess) popupAccess.value = accessSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { accessLevel: accessSelect.value } });
      });

      // Agent settings event handlers
      var autoSuggestToggle = document.getElementById('auto-suggest-toggle');
      var tokenLimitToggle = document.getElementById('token-limit-toggle');
      var tokenBudgetInput = document.getElementById('token-budget-input');
      var tokenBudgetSection = document.getElementById('token-budget-section');
      var suggestionsToggle = document.getElementById('suggestions-toggle');

      if (autoSuggestToggle) {
        autoSuggestToggle.addEventListener('click', function() {
          state.agentSettings.autoSuggest = !state.agentSettings.autoSuggest;
          if (state.agentSettings.autoSuggest) {
            autoSuggestToggle.classList.add('active');
          } else {
            autoSuggestToggle.classList.remove('active');
          }
          postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.autoSuggest': state.agentSettings.autoSuggest } });
        });
      }

      if (tokenLimitToggle) {
        tokenLimitToggle.addEventListener('click', function() {
          state.agentSettings.tokenLimitEnabled = !state.agentSettings.tokenLimitEnabled;
          if (state.agentSettings.tokenLimitEnabled) {
            tokenLimitToggle.classList.add('active');
            if (tokenBudgetSection) tokenBudgetSection.classList.remove('hidden');
            // Restore budget value when enabled
            var budgetValue = state.agentSettings.maxTokenBudget || 2000;
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': budgetValue } });
          } else {
            tokenLimitToggle.classList.remove('active');
            if (tokenBudgetSection) tokenBudgetSection.classList.add('hidden');
            // Set to 0 (unlimited) when disabled
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': 0 } });
          }
        });
      }

      if (tokenBudgetInput) {
        tokenBudgetInput.addEventListener('change', function() {
          var value = parseInt(tokenBudgetInput.value, 10);
          if (value < 100) value = 100;
          if (value > 16000) value = 16000;
          tokenBudgetInput.value = value;
          state.agentSettings.maxTokenBudget = value;
          postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': value } });
        });
      }

      if (suggestionsToggle) {
        suggestionsToggle.addEventListener('click', function() {
          state.agentSettings.showSuggestions = !state.agentSettings.showSuggestions;
          var quickActionsContainer = document.getElementById('quick-actions-container');
          if (state.agentSettings.showSuggestions) {
            suggestionsToggle.classList.add('active');
            if (quickActionsContainer) quickActionsContainer.classList.remove('hidden');
          } else {
            suggestionsToggle.classList.remove('active');
            if (quickActionsContainer) quickActionsContainer.classList.add('hidden');
          }
          postMessageWithPanelId({ type: 'updateSettings', payload: { showSuggestions: state.agentSettings.showSuggestions } });
        });
      }

      // Autonomy level dropdown handler (mutually exclusive: manual / semi-autonomous / autonomous)
      var autonomySelect = document.getElementById('autonomy-select');
      var manualTimeoutSection = document.getElementById('manual-timeout-section');
      var semiAutoSettings = document.getElementById('semi-auto-settings');
      var autonomousSettings = document.getElementById('autonomous-settings');
      var autonomousOverlay = document.getElementById('autonomous-confirm-overlay');
      var autonomousGoalInput = document.getElementById('autonomous-goal-input');
      var autonomousConfirmBtn = document.getElementById('autonomous-confirm-btn');
      var autonomousCancelBtn = document.getElementById('autonomous-cancel-btn');

      function showAutonomySubSettings(level) {
        if (manualTimeoutSection) manualTimeoutSection.classList.toggle('hidden', level !== 'manual');
        if (semiAutoSettings) semiAutoSettings.classList.toggle('hidden', level !== 'semi-autonomous');
        if (autonomousSettings) autonomousSettings.classList.toggle('hidden', level !== 'autonomous');
      }

      function updateAutonomyIndicator() {
        var indicator = document.getElementById('autonomy-indicator');
        var label = document.getElementById('autonomy-indicator-label');
        if (!indicator) return;
        indicator.classList.remove('autonomous', 'semi-autonomous');
        if (state.autonomyLevel === 'autonomous') {
          indicator.style.display = 'flex';
          indicator.classList.add('autonomous');
          if (label) label.textContent = 'Autonomous';
        } else if (state.autonomyLevel === 'semi-autonomous') {
          indicator.style.display = 'flex';
          indicator.classList.add('semi-autonomous');
          if (label) label.textContent = 'Semi-Auto';
        } else {
          indicator.style.display = 'none';
        }
      }

      function setAutonomyLevel(newLevel) {
        var prevLevel = state.autonomyLevel;
        state.previousAutonomyLevel = prevLevel;

        // Deactivate autonomous manager if leaving autonomous
        if (prevLevel === 'autonomous' && newLevel !== 'autonomous') {
          postMessageWithPanelId({ type: 'deactivateAutonomous' });
        }

        state.autonomyLevel = newLevel;
        showAutonomySubSettings(newLevel);

        // Notify backend of autonomy level change (authoritative source for semi-auto checks)
        postMessageWithPanelId({
          type: 'autonomyLevelChanged',
          payload: { level: newLevel }
        });

        if (newLevel === 'manual') {
          // Restore normal timeout behavior from the manual dropdown
          var tbSelect = document.getElementById('timeout-behavior-select');
          var tbValue = tbSelect ? tbSelect.value : 'auto-reject';
          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'permission.timeoutBehavior': tbValue }
          });
        } else if (newLevel === 'semi-autonomous') {
          // Set semi-autonomous timeout behavior (no AutonomousManager activation)
          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'permission.timeoutBehavior': 'semi-autonomous' }
          });
        } else if (newLevel === 'autonomous') {
          // Show confirmation modal (same flow as before)
          postMessageWithPanelId({ type: 'toggleAutonomous' });
        }

        // Sync dropdowns
        if (autonomySelect) autonomySelect.value = newLevel;
        var popupAutonomy = document.getElementById('popup-autonomy-select');
        if (popupAutonomy) popupAutonomy.value = newLevel;

        updateAutonomyIndicator();
        updateBehaviorIndicator();
      }

      if (autonomySelect) {
        autonomySelect.addEventListener('change', function() {
          setAutonomyLevel(autonomySelect.value);
        });
      }

      // Safety level selects (both share same setting)
      var semiAutoSafetySelect = document.getElementById('semi-auto-safety-select');
      var autonomousSafetySelect = document.getElementById('autonomous-safety-select');

      function syncSafetySelects(value) {
        if (semiAutoSafetySelect) semiAutoSafetySelect.value = value;
        if (autonomousSafetySelect) autonomousSafetySelect.value = value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { 'autonomous.safetyMode': value } });
      }

      if (semiAutoSafetySelect) {
        semiAutoSafetySelect.addEventListener('change', function() {
          syncSafetySelects(semiAutoSafetySelect.value);
        });
      }

      if (autonomousSafetySelect) {
        autonomousSafetySelect.addEventListener('change', function() {
          syncSafetySelects(autonomousSafetySelect.value);
        });
      }

      // Permission timeout behavior (manual mode)
      var timeoutBehaviorSelect = document.getElementById('timeout-behavior-select');

      if (timeoutBehaviorSelect) {
        timeoutBehaviorSelect.addEventListener('change', function() {
          var value = timeoutBehaviorSelect.value;
          postMessageWithPanelId({ type: 'updateSettings', payload: { 'permission.timeoutBehavior': value } });
        });
      }

      // Semi-auto timeout duration
      var semiAutoTimeoutInput = document.getElementById('semi-auto-timeout-input');

      if (semiAutoTimeoutInput) {
        semiAutoTimeoutInput.addEventListener('change', function() {
          var val = parseInt(semiAutoTimeoutInput.value, 10);
          if (val >= 10 && val <= 300) {
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'semiAutonomous.timeout': val } });
          }
        });
      }

      // Popup autonomy dropdown
      var popupAutonomySelect = document.getElementById('popup-autonomy-select');
      if (popupAutonomySelect) {
        popupAutonomySelect.addEventListener('change', function() {
          setAutonomyLevel(popupAutonomySelect.value);
        });
      }

      if (autonomousConfirmBtn) {
        autonomousConfirmBtn.addEventListener('click', function() {
          var goalText = autonomousGoalInput ? autonomousGoalInput.value.trim() : '';
          if (autonomousOverlay) autonomousOverlay.classList.add('hidden');
          postMessageWithPanelId({
            type: 'confirmAutonomousActivation',
            payload: { goal: goalText || undefined }
          });
        });
      }

      if (autonomousCancelBtn) {
        autonomousCancelBtn.addEventListener('click', function() {
          if (autonomousOverlay) autonomousOverlay.classList.add('hidden');
          // Revert to previous level since user cancelled
          state.autonomyLevel = state.previousAutonomyLevel;
          if (autonomySelect) autonomySelect.value = state.autonomyLevel;
          var popupAut = document.getElementById('popup-autonomy-select');
          if (popupAut) popupAut.value = state.autonomyLevel;
          showAutonomySubSettings(state.autonomyLevel);
          updateAutonomyIndicator();
          updateBehaviorIndicator();
          postMessageWithPanelId({ type: 'cancelAutonomousActivation' });
        });
      }

      // Quick actions hide button handler
      var quickActionsHideBtn = document.getElementById('quick-actions-hide');
      if (quickActionsHideBtn) {
        quickActionsHideBtn.addEventListener('click', function() {
          state.agentSettings.showSuggestions = false;
          var quickActionsContainer = document.getElementById('quick-actions-container');
          if (quickActionsContainer) quickActionsContainer.classList.add('hidden');
          // Update settings toggle if visible
          if (suggestionsToggle) suggestionsToggle.classList.remove('active');
          postMessageWithPanelId({ type: 'updateSettings', payload: { showSuggestions: false } });
        });
      }

      // Brainstorm agent selection handlers. The checkbox NodeList is
      // re-assigned by renderBrainstormAgentOptions whenever the manifest
      // (re)builds the options — it is empty until the manifest arrives.
      var brainstormAgentSection = document.getElementById('brainstorm-agents-section');
      var brainstormAgentCheckboxes = document.querySelectorAll('input[name="brainstorm-agent"]');
      var brainstormAgentError = document.getElementById('brainstorm-agent-error');

      function updateBrainstormAgentSelection() {
        var selected = [];
        brainstormAgentCheckboxes.forEach(function(cb) {
          if (cb.checked) {
            selected.push(cb.value);
          }
        });

        // Validate: exactly 2 must be selected
        if (selected.length === 2) {
          brainstormAgentError.classList.add('hidden');
          state.brainstormAgents = selected;
          // Persist to settings
          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'brainstorm.agents': selected }
          });
        } else {
          brainstormAgentError.classList.remove('hidden');
        }

        // Disable unchecked options if 2 are already selected
        brainstormAgentCheckboxes.forEach(function(cb) {
          var option = cb.closest('.brainstorm-agent-option');
          if (selected.length >= 2 && !cb.checked) {
            option.classList.add('disabled');
          } else {
            option.classList.remove('disabled');
          }
        });
      }

      // (change handlers are attached by renderBrainstormAgentOptions when
      // the options are built from the manifest)

      // Brainstorm strategy selector handler
      var brainstormStrategySelect = document.getElementById('brainstorm-strategy-select');
      var brainstormStrategyHint = document.getElementById('brainstorm-strategy-hint');
      var brainstormStrategySection = document.getElementById('brainstorm-strategy-section');

      var strategyDescriptions = {
        'quick': 'Direct synthesis without discussion (fastest)',
        'debate': 'Agents critique each other with structured rebuttals',
        'red-team': 'One proposes, one challenges, then defense',
        'perspectives': 'Risk analysis vs. opportunity analysis lenses',
        'delphi': 'Facilitator-mediated iterative convergence'
      };

      if (brainstormStrategySelect) {
        brainstormStrategySelect.addEventListener('change', function() {
          var strategy = brainstormStrategySelect.value;
          state.brainstormStrategy = strategy;
          if (brainstormStrategyHint) {
            brainstormStrategyHint.textContent = strategyDescriptions[strategy] || '';
          }
          // Sync the toolbar chip
          updateStrategyIndicator();
          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'brainstorm.strategy': strategy }
          });
        });
      }

      // Function to show/hide brainstorm section based on provider availability
      function updateBrainstormSectionVisibility() {
        if (!brainstormAgentSection) return;

        var providerAvailability = state.providerAvailability || {};

        // Count available providers (W9: ids come from the manifest)
        var availableCount = 0;
        getManifestProviderIds().forEach(function(providerId) {
          if (providerAvailability[providerId] &&
              providerAvailability[providerId].available) {
            availableCount++;
          }
        });

        // Show section only if 2+ providers are available
        if (availableCount >= 2) {
          brainstormAgentSection.classList.remove('hidden');
          if (brainstormStrategySection) {
            brainstormStrategySection.classList.remove('hidden');
          }

          // Disable unavailable provider checkboxes
          brainstormAgentCheckboxes.forEach(function(cb) {
            var providerId = cb.value;
            var option = cb.closest('.brainstorm-agent-option');
            if (providerAvailability[providerId] &&
                !providerAvailability[providerId].available) {
              option.classList.add('disabled');
              cb.disabled = true;
              // If this was selected, uncheck and revalidate
              if (cb.checked) {
                cb.checked = false;
                updateBrainstormAgentSelection();
              }
            } else {
              cb.disabled = false;
            }
          });
        } else {
          brainstormAgentSection.classList.add('hidden');
          if (brainstormStrategySection) {
            brainstormStrategySection.classList.add('hidden');
          }
        }
      }

      // Function to sync brainstorm agents UI from state
      function updateBrainstormAgentsUI() {
        if (!state.brainstormAgents) return;

        brainstormAgentCheckboxes.forEach(function(cb) {
          cb.checked = state.brainstormAgents.includes(cb.value);
        });

        // Re-apply disabled states
        var selected = state.brainstormAgents.length;
        brainstormAgentCheckboxes.forEach(function(cb) {
          var option = cb.closest('.brainstorm-agent-option');
          if (selected >= 2 && !cb.checked) {
            option.classList.add('disabled');
          } else {
            option.classList.remove('disabled');
          }
        });

        if (brainstormAgentError) {
          brainstormAgentError.classList.add('hidden');
        }
      }

      providerSelect.addEventListener('change', function() {
        var newProvider = providerSelect.value;

        // Update state for all agent types including brainstorm
        state.settings.provider = newProvider;
        state.activeAgent = newProvider;
        updateAgentMenuSelection();

        if (newProvider !== 'brainstorm') {
          // Update model dropdown with provider-specific models (brainstorm doesn't have its own models)
          updateModelsForProvider(newProvider);
        }

        // W1: thinking selector visibility is capability-driven
        updateThinkingSectionVisibility(newProvider);

        // Show/hide strategy indicator chip for brainstorm
        updateStrategyIndicatorVisibility(newProvider);

        // Notify backend of provider change
        postMessageWithPanelId({ type: 'updateSettings', payload: { provider: newProvider } });
      });

      // W1: show/hide the thinking selector from capabilities — hidden when
      // the provider never emits thinking (thinkingStyle 'none'); shown with
      // an advisory hint when it emits thinking but doesn't enforce the
      // selected level (thinkingLevelEffective false). Unknown ids (the
      // brainstorm pseudo-agent, pre-manifest renders) keep it visible.
      function updateThinkingSectionVisibility(provider) {
        var thinkingSection = document.getElementById('thinking-section');
        if (!thinkingSection) return;
        var entry = getManifestEntry(provider);
        var caps = entry && entry.capabilities;
        var hidden = !!(caps && caps.thinkingStyle === 'none');
        thinkingSection.style.display = hidden ? 'none' : 'block';
        var advisoryHint = document.getElementById('thinking-advisory-hint');
        if (advisoryHint) {
          var advisory = !hidden && !!caps && caps.thinkingLevelEffective === false;
          advisoryHint.classList.toggle('hidden', !advisory);
        }
      }

      // Function to show/hide strategy indicator chip based on provider
      function updateStrategyIndicatorVisibility(provider) {
        if (!strategyIndicator) return;
        if (provider === 'brainstorm') {
          strategyIndicator.classList.remove('hidden');
          updateStrategyIndicator();
        } else {
          strategyIndicator.classList.add('hidden');
        }
      }

      if (contextModeBtn && contextModeLabel) {
        contextModeBtn.addEventListener('click', function() {
          state.settings.contextMode = state.settings.contextMode === 'auto' ? 'manual' : 'auto';
          contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
          postMessageWithPanelId({ type: 'updateSettings', payload: { contextMode: state.settings.contextMode } });
        });
      }

      // Behavior indicator click to open popup
      if (behaviorIndicator && behaviorPopup) {
        behaviorIndicator.addEventListener('click', function(e) {
          e.stopPropagation();
          var isHidden = behaviorPopup.classList.contains('hidden');
          behaviorPopup.classList.toggle('hidden', !isHidden);
          if (isHidden) {
            // Highlight the current mode when the picker opens.
            renderModeOptions();
          }
        });

        // Plan 06: pick a mode from the single Mode picker.
        behaviorPopup.addEventListener('click', function(e) {
          var opt = e.target.closest ? e.target.closest('.mode-option') : null;
          if (!opt) { return; }
          applyChatMode(opt.getAttribute('data-mode'));
          behaviorPopup.classList.add('hidden');
        });

        // Close popup on click outside
        document.addEventListener('click', function(e) {
          if (behaviorPopup && !behaviorPopup.classList.contains('hidden') &&
              !behaviorPopup.contains(e.target) && e.target !== behaviorIndicator) {
            behaviorPopup.classList.add('hidden');
          }
        });

        // Close popup on Escape
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && behaviorPopup && !behaviorPopup.classList.contains('hidden')) {
            behaviorPopup.classList.add('hidden');
          }
        });
      }

      // Plan 06 Phase 3: "⋯" tools menu (enhance / visual test / canvas /
      // persona). The items keep their own id-bound handlers; this just toggles
      // the menu and closes it after a pick / outside click / Escape.
      var toolsMenuBtn = document.getElementById('tools-menu-btn');
      var toolsMenu = document.getElementById('tools-menu');
      if (toolsMenuBtn && toolsMenu) {
        toolsMenuBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          toolsMenu.classList.toggle('hidden');
        });
        toolsMenu.addEventListener('click', function(e) {
          // Close after an action runs; keep open when clearing the persona.
          if (e.target.closest('.tools-menu-item') && !e.target.closest('#toolbar-persona-clear')) {
            toolsMenu.classList.add('hidden');
          }
        });
        document.addEventListener('click', function(e) {
          if (!toolsMenu.classList.contains('hidden') &&
              !toolsMenu.contains(e.target) &&
              e.target !== toolsMenuBtn && !toolsMenuBtn.contains(e.target)) {
            toolsMenu.classList.add('hidden');
          }
        });
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && !toolsMenu.classList.contains('hidden')) {
            toolsMenu.classList.add('hidden');
          }
        });
      }

      // Popup mode/access dropdowns sync with settings panel
      var popupModeSelect = document.getElementById('popup-mode-select');
      var popupAccessSelect = document.getElementById('popup-access-select');

      if (popupModeSelect) {
        popupModeSelect.addEventListener('change', function() {
          var newMode = popupModeSelect.value;
          state.settings.mode = newMode;
          if (modeSelect) modeSelect.value = newMode;
          updateBehaviorIndicator();
          updateBehaviorHint();
          postMessageWithPanelId({ type: 'updateSettings', payload: { mode: newMode } });
        });
      }

      if (popupAccessSelect) {
        popupAccessSelect.addEventListener('change', function() {
          var newAccess = popupAccessSelect.value;
          state.settings.accessLevel = newAccess;
          var accessSelect = document.getElementById('access-select');
          if (accessSelect) accessSelect.value = newAccess;
          updateBehaviorHint();
          postMessageWithPanelId({ type: 'updateSettings', payload: { accessLevel: newAccess } });
        });
      }

      // Strategy indicator click to cycle through brainstorm strategies
      var strategyIndicator = document.getElementById('strategy-indicator');
      var strategyList = ['quick', 'debate', 'red-team', 'perspectives', 'delphi'];
      var strategyLabels = {
        'quick': 'Quick',
        'debate': 'Debate',
        'red-team': 'Red Team',
        'perspectives': 'Perspectives',
        'delphi': 'Delphi'
      };

      function updateStrategyIndicator() {
        if (!strategyIndicator) return;
        var current = state.brainstormStrategy || 'quick';
        strategyIndicator.textContent = strategyLabels[current] || current;
        strategyIndicator.title = 'Strategy: ' + (strategyDescriptions[current] || current) + ' (click to cycle)';
      }

      if (strategyIndicator) {
        strategyIndicator.addEventListener('click', function() {
          var current = state.brainstormStrategy || 'quick';
          var currentIndex = strategyList.indexOf(current);
          var nextIndex = (currentIndex + 1) % strategyList.length;
          var newStrategy = strategyList[nextIndex];

          state.brainstormStrategy = newStrategy;
          updateStrategyIndicator();

          // Sync the settings panel dropdown
          if (brainstormStrategySelect) {
            brainstormStrategySelect.value = newStrategy;
          }
          if (brainstormStrategyHint) {
            brainstormStrategyHint.textContent = strategyDescriptions[newStrategy] || '';
          }

          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'brainstorm.strategy': newStrategy }
          });
        });
      }

      if (addContextBtn) {
        addContextBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'getWorkspaceFiles' });
        });
      }

      if (clearContextBtn) {
        clearContextBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'clearContext' });
        });
      }

      slashCmdBtn.addEventListener('click', function() {
        if (state.slashMenuVisible) {
          hideSlashMenu();
        } else {
          inputEl.value = '/';
          inputEl.focus();
          showSlashMenu('');
        }
      });

      // Agent menu toggle
      if (agentSelectBtn && agentMenu) {
        agentSelectBtn.addEventListener('click', function() {
          agentMenu.classList.toggle('hidden');
          // Close slash menu if open
          if (slashMenu) slashMenu.classList.add('hidden');
        });

        // Agent menu clicks with event delegation
        agentMenu.addEventListener('click', function(e) {
          // FIRST: Check if Install button was clicked (highest priority)
          var installBtn = e.target.closest('.agent-install-btn');
          if (installBtn) {
            e.preventDefault();
            e.stopPropagation();
            var agentId = installBtn.dataset.agent;
            console.log('[Mysti Webview] Install button clicked via delegation for:', agentId);
            if (agentId) {
              showInstallProviderModal(agentId);
            }
            return;
          }

          // SECOND: Check if a menu item was clicked
          var menuItem = e.target.closest('.agent-menu-item');
          if (!menuItem) return; // Click was on header/divider/etc

          // Skip disabled items
          if (menuItem.classList.contains('disabled')) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          // Handle normal agent selection
          var agent = menuItem.dataset.agent;
          if (agent) {
            state.activeAgent = agent;
            state.settings.provider = agent;

            if (providerSelect) providerSelect.value = agent;

            if (agent !== 'brainstorm') {
              updateModelsForProvider(agent);
            }

            updateThinkingSectionVisibility(agent);
            updateStrategyIndicatorVisibility(agent);
            updateAgentMenuSelection();
            agentMenu.classList.add('hidden');

            postMessageWithPanelId({ type: 'updateSettings', payload: { provider: agent } });
          }
        });
      }

      function updateModelsForProvider(providerId) {
        if (!state.providers || state.providers.length === 0) return;

        var provider = state.providers.find(function(p) { return p.name === providerId; });
        if (provider && provider.models) {
          modelSelect.innerHTML = provider.models.map(function(m) {
            return '<option value="' + m.id + '">' + m.name + '</option>';
          }).join('');

          // Append "Custom..." option for custom model override
          modelSelect.innerHTML += '<option value="__custom__">Custom...</option>';

          // Select the provider's default model, or keep current if valid for the new provider
          if (provider.models.length > 0) {
            var currentModelExists = provider.models.some(function(m) { return m.id === state.settings.model; });
            if (!currentModelExists) {
              state.settings.model = provider.defaultModel || provider.models[0].id;
              modelSelect.value = state.settings.model;
              // Notify backend of model change
              postMessageWithPanelId({ type: 'updateSettings', payload: { model: state.settings.model } });
            }
          }

          // Reset custom model section when switching providers
          customModelSection.classList.add('hidden');
          customModelInput.value = '';
          customModelError.style.display = 'none';
          customModelInput.style.borderColor = '';
        }

        // W4: render this provider's declarative settings sections
        renderProviderSettingsSections(providerId);
      }

      function updateAgentMenuSelection() {
        document.querySelectorAll('.agent-menu-item[data-agent]').forEach(function(item) {
          if (item.dataset.agent === state.activeAgent) {
            item.classList.add('selected');
            // Show "Active" badge
            var badge = item.querySelector('.agent-item-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'agent-item-badge';
              badge.textContent = 'Active';
              item.appendChild(badge);
            }
          } else {
            item.classList.remove('selected');
            // Remove "Active" badge
            var badge = item.querySelector('.agent-item-badge');
            if (badge) badge.remove();
          }
        });
        // Update agent button label and icon (W6: identity from the manifest;
        // 'brainstorm' is a pseudo-agent with Mysti branding)
        var agentNameEl = document.getElementById('agent-name');
        var agentIconEl = document.getElementById('agent-icon');
        var isBrainstorm = state.activeAgent === 'brainstorm';
        if (agentNameEl) {
          agentNameEl.textContent = isBrainstorm ? 'Brainstorm' : getAgentDisplay(state.activeAgent).name;
        }
        if (agentIconEl) {
          var img = agentIconEl.querySelector('img');
          if (img) {
            var logo = isBrainstorm ? MYSTI_LOGO : getAgentLogo(state.activeAgent);
            img.src = logo || MYSTI_LOGO;
          }
        }
        // Sync settings provider dropdown (only for actual providers, not brainstorm)
        if (providerSelect && state.activeAgent !== 'brainstorm' && providerSelect.value !== state.activeAgent) {
          providerSelect.value = state.activeAgent;
        }
      }

      // W7: refresh every theme-aware provider logo from the manifest
      // (entries with themeAwareLogo swap icon/iconDark with the theme).
      // Rendered logos carry data-agent-logo="<providerId>".
      function updateThemeAwareLogos() {
        var providers = (state.providerManifest && state.providerManifest.providers) || [];
        providers.forEach(function(entry) {
          if (!entry.themeAwareLogo) return;
          var logo = getEntryLogo(entry);
          if (!logo) return;
          document.querySelectorAll('img[data-agent-logo="' + entry.id + '"]').forEach(function(img) {
            img.src = logo;
          });
          // Also update the toolbar icon if it currently shows this agent
          if (state.activeAgent === entry.id) {
            var agentIconEl = document.getElementById('agent-icon');
            if (agentIconEl) {
              var img = agentIconEl.querySelector('img');
              if (img) img.src = logo;
            }
          }
        });
      }

      /**
       * Update provider availability in the UI
       * - Disables unavailable providers in dropdowns and agent menu
       * - Auto-selects first available provider if current is unavailable
       * - Handles brainstorm availability (requires 2+ providers)
       */
      function updateProviderAvailability() {
        if (!state.providerAvailability) return;

        var availability = state.providerAvailability;

        // Count available providers (W9: ids come from the manifest)
        var availableCount = 0;
        var firstAvailable = null;
        getManifestProviderIds().forEach(function(providerId) {
          if (availability[providerId] && availability[providerId].available) {
            availableCount++;
            if (!firstAvailable) firstAvailable = providerId;
          }
        });

        // Update provider dropdown options
        if (providerSelect) {
          Array.from(providerSelect.options).forEach(function(option) {
            var providerId = option.value;
            if (providerId === 'brainstorm') {
              // Brainstorm requires 2+ available providers
              if (availableCount < 2) {
                option.disabled = true;
                option.textContent = 'Brainstorm (requires 2+ providers)';
              } else {
                option.disabled = false;
                option.textContent = 'Brainstorm';
              }
            } else if (availability[providerId]) {
              if (!availability[providerId].available) {
                option.disabled = true;
                option.textContent = option.textContent.replace(' (not installed)', '') + ' (not installed)';
              } else {
                option.disabled = false;
                option.textContent = option.textContent.replace(' (not installed)', '');
              }
            }
          });
        }

        // Update agent menu items
        document.querySelectorAll('.agent-menu-item[data-agent]').forEach(function(item) {
          var agentId = item.dataset.agent;

          if (agentId === 'brainstorm') {
            // Brainstorm requires 2+ available providers
            if (availableCount < 2) {
              item.classList.add('disabled');
              item.title = 'Requires 2+ installed providers';
              // Add disabled badge
              var existingBadge = item.querySelector('.agent-item-badge');
              if (!existingBadge || existingBadge.textContent === 'Active') {
                var badge = existingBadge || document.createElement('span');
                badge.className = 'agent-item-badge';
                badge.textContent = 'Requires 2+';
                if (!existingBadge) item.appendChild(badge);
              }
            } else {
              item.classList.remove('disabled');
              item.title = '';
              // Remove disabled badge if not active
              var badge = item.querySelector('.agent-item-badge');
              if (badge && badge.textContent === 'Requires 2+') {
                badge.remove();
              }
            }
          } else if (availability[agentId]) {
            if (!availability[agentId].available) {
              item.classList.add('disabled');
              item.dataset.installCommand = availability[agentId].installCommand || '';
              item.title = 'Not installed - click Install to set up';

              // Add or update "Not Installed" badge inside the item
              var badge = item.querySelector('.agent-item-badge');
              if (!badge) {
                badge = document.createElement('span');
                badge.className = 'agent-item-badge';
                item.appendChild(badge);
              }
              badge.textContent = 'Not Installed';

              // Add Install button inside the menu item (CSS handles pointer-events)
              var installBtn = item.querySelector('.agent-install-btn');
              if (!installBtn) {
                installBtn = document.createElement('button');
                installBtn.className = 'agent-install-btn';
                installBtn.dataset.agent = agentId;
                installBtn.textContent = 'Install';
                installBtn.addEventListener('click', function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  console.log('[Mysti Webview] Install button clicked for:', agentId);
                  showInstallProviderModal(agentId);
                });
                item.appendChild(installBtn);
              }
            } else {
              item.classList.remove('disabled');
              item.title = '';
              delete item.dataset.installCommand;
              // Remove "Not Installed" badge
              var badge = item.querySelector('.agent-item-badge');
              if (badge && badge.textContent === 'Not Installed') {
                badge.remove();
              }
              // Remove Install button
              var installBtn = item.querySelector('.agent-install-btn');
              if (installBtn) {
                installBtn.remove();
              }
            }
          }
        });

        // Auto-select first available provider if current is unavailable
        var currentProvider = state.settings.provider;
        if (currentProvider && currentProvider !== 'brainstorm') {
          if (availability[currentProvider] && !availability[currentProvider].available) {
            if (firstAvailable) {
              console.log('[Mysti Webview] Current provider unavailable, switching to:', firstAvailable);
              state.settings.provider = firstAvailable;
              state.activeAgent = firstAvailable;
              if (providerSelect) providerSelect.value = firstAvailable;
              updateAgentMenuSelection();
              updateModelsForProvider(firstAvailable);
              postMessageWithPanelId({ type: 'updateSettings', payload: { provider: firstAvailable } });
            }
          }
        } else if (currentProvider === 'brainstorm' && availableCount < 2) {
          // Brainstorm selected but not enough providers
          if (firstAvailable) {
            console.log('[Mysti Webview] Brainstorm unavailable (need 2+ providers), switching to:', firstAvailable);
            state.settings.provider = firstAvailable;
            state.activeAgent = firstAvailable;
            if (providerSelect) providerSelect.value = firstAvailable;
            updateAgentMenuSelection();
            updateModelsForProvider(firstAvailable);
            postMessageWithPanelId({ type: 'updateSettings', payload: { provider: firstAvailable } });
          }
        }

        // Update brainstorm agent section visibility
        updateBrainstormSectionVisibility();
      }

      // Watch for theme changes
      var themeObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.attributeName === 'class') {
            updateThemeAwareLogos();
          }
        });
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

      var enhanceTimeout = null;
      enhanceBtn.addEventListener('click', function() {
        if (inputEl.value.trim() && !enhanceBtn.classList.contains('enhancing')) {
          // Add enhancing state - show loader and disable inputs
          enhanceBtn.classList.add('enhancing');
          enhanceBtn.title = 'Enhancing prompt...';
          var inputArea = document.querySelector('.input-area');
          if (inputArea) inputArea.classList.add('enhancing');

          // Safety timeout - reset UI if no response after 30 seconds
          enhanceTimeout = setTimeout(function() {
            if (enhanceBtn.classList.contains('enhancing')) {
              enhanceBtn.classList.remove('enhancing');
              enhanceBtn.title = 'Enhance prompt';
              var ia = document.querySelector('.input-area');
              if (ia) ia.classList.remove('enhancing');
              inputEl.placeholder = 'Enhancement timed out. Try again.';
              setTimeout(function() {
                inputEl.placeholder = 'Ask Mysti...';
              }, 3000);
            }
          }, 30000);

          postMessageWithPanelId({ type: 'enhancePrompt', payload: inputEl.value });
        }
      });

      if (contextItems) {
        contextItems.addEventListener('dragover', function(e) {
          e.preventDefault();
          contextItems.style.background = 'var(--vscode-list-hoverBackground)';
        });

        contextItems.addEventListener('dragleave', function() {
          contextItems.style.background = '';
        });

        contextItems.addEventListener('drop', function(e) {
          e.preventDefault();
          contextItems.style.background = '';
          handleDroppedFiles(e.dataTransfer);
        });
      }

      window.addEventListener('message', function(event) {
        handleMessage(event.data);
      });

      function handleMessage(message) {
        switch (message.type) {
          case 'initialState':
            initializeState(message.payload);
            break;
          case 'messageAdded':
            addMessage(message.payload);
            break;
          case 'responseStarted':
            // Perf: per-response chunk counter (ring buffer keeps rolling
            // across responses — "last 2000 samples").
            if (perfState.enabled) perfState.chunkCount = 0;
            // Clean up any incomplete streaming message from previous request
            var oldStreaming = messagesEl.querySelector('.message.streaming:not([data-brainstorm-synthesis])');
            if (oldStreaming) {
              console.log('[Mysti Webview] Cleaning up old streaming message');
              oldStreaming.classList.remove('streaming');
              // Reset streaming buffers
              currentResponse = '';
              currentThinking = '';
              contentSegmentIndex = 0;
            }
            showLoading();
            break;
          case 'responseChunk':
            handleResponseChunk(message.payload);
            break;
          case 'responseComplete':
            // Perf: post the per-response chunk-cost summary + heap sample
            // ("done" report). No-op (single boolean check) when disabled.
            if (perfState.enabled) postMessageWithPanelId(perfBuildReport());
            hideLoading();
            // Payload is { message, usage } - extract message for finalization
            var responsePayload = message.payload || {};
            var completedMessage = responsePayload.message || responsePayload;
            var finalizedEl = finalizeStreamingMessage(completedMessage);
            // Plan 02 Phase 3.4: unified footer (also auto-resolves running
            // tool cards for providers that never stream tool_result)
            if (finalizedEl) {
              renderMessageFooter(
                finalizedEl,
                responsePayload.usage || null,
                getMessageAttribution(completedMessage),
                []
              );
            }
            // Update context usage from response
            // Total context = input_tokens + cache_read_input_tokens (cached context being used)
            if (responsePayload.usage) {
              var totalContextTokens = (responsePayload.usage.input_tokens || 0) +
                                       (responsePayload.usage.cache_read_input_tokens || 0);
              console.log('[Mysti Webview] Context usage - input:', responsePayload.usage.input_tokens,
                          'cached:', responsePayload.usage.cache_read_input_tokens,
                          'total:', totalContextTokens);
              updateContextUsage(totalContextTokens, null);
            }
            break;
          case 'contextWindowInfo':
            // Update context window size for the current model
            if (message.payload && message.payload.contextWindow) {
              updateContextUsage(state.contextUsage.usedTokens, message.payload.contextWindow);
            }
            break;
          case 'compactionStatus':
            handleCompactionStatus(message.payload);
            break;
          case 'requestCancelled':
            hideLoading();
            // Hide suggestion skeleton if showing
            var quickActionsContainer = document.getElementById('quick-actions');
            if (quickActionsContainer) {
              quickActionsContainer.classList.remove('loading');
              quickActionsContainer.innerHTML = '';
            }
            break;
          // Sub-agent response events (from @-mentions)
          case 'subAgentStarted':
            handleSubAgentStarted(message.payload);
            break;
          case 'mentionTaskListGenerated':
            handleMentionTaskListGenerated(message.payload);
            break;
          case 'mentionTaskStarted':
            handleMentionTaskStarted(message.payload);
            break;
          case 'mentionTaskComplete':
            handleMentionTaskComplete(message.payload);
            break;
          case 'subAgentChunk':
            handleSubAgentChunk(message.payload);
            break;
          case 'subAgentComplete':
            handleSubAgentComplete(message.payload);
            break;
          case 'subAgentError':
            handleSubAgentError(message.payload);
            break;
          case 'subAgentToolUse':
            handleSubAgentToolUse(message.payload);
            break;
          case 'subAgentToolResult':
            handleSubAgentToolResult(message.payload);
            break;
          case 'subAgentRetry':
            handleSubAgentRetry(message.payload);
            break;
          case 'subAgentAskUserQuestion':
            handleSubAgentAskUserQuestion(message.payload);
            break;
          case 'subAgentStatus':
            handleSubAgentStatus(message.payload);
            break;
          case 'mentionFilesResolved':
            // File mentions resolved - no special UI needed
            break;
          case 'providerSwitched':
            if (message.payload && message.payload.provider) {
              var switchedEntry = getManifestEntry(message.payload.provider);
              showToast('Switched to ' + (switchedEntry ? switchedEntry.displayName : message.payload.provider), 'info');
            }
            break;

          case 'settingsError':
            // Extension-side validation failures for settings writes (e.g. an
            // invalid Codex profile name posted via a W4 settings section).
            if (message.payload && message.payload.error) {
              showToast(message.payload.error, 'error');
            }
            break;

          case 'manifestUpdated':
            // Plan 02 Phase 2: the extension re-broadcasts the capability
            // manifest on provider availability changes and on changes to
            // manifest-affecting settings. Payload IS the
            // ProviderManifestPayload ({ schemaVersion, providers }).
            if (message.payload && message.payload.providers) {
              if (message.payload.schemaVersion !== EXPECTED_MANIFEST_SCHEMA_VERSION) {
                console.warn('[Mysti Webview] Ignoring manifestUpdated with unexpected schemaVersion:', message.payload.schemaVersion);
                break;
              }
              state.providerManifest = message.payload;
              applyProviderManifest();
              if (state.settings && state.settings.provider) {
                renderProviderSettingsSections(state.settings.provider);
                updateThinkingSectionVisibility(state.settings.provider);
              }
              updateAgentMenuSelection();
              updateThemeAwareLogos();
              updateProviderAvailability();
            }
            break;

          case 'providerAvailability':
            // Plan 03 Phase 3a: provider statuses are NOT final at
            // initialState — the extension posts this follow-up once the
            // background CLI discovery refresh settles (and after manual
            // refresh). Merge and re-render badges/dropdowns/brainstorm.
            if (message.payload && message.payload.providerAvailability) {
              state.providerAvailability = Object.assign(
                {},
                state.providerAvailability,
                message.payload.providerAvailability
              );
              updateProviderAvailability();
            }
            break;

          case 'imageWarning':
          case 'attachmentWarning':
            if (message.payload && message.payload.message) {
              showToast(message.payload.message, 'warning');
            }
            break;

          case 'fileAttachmentSelected':
            if (message.payload && message.payload.attachments) {
              for (var fai = 0; fai < message.payload.attachments.length; fai++) {
                if (state.attachments.length >= 10) {
                  showToast('Maximum 10 attachments per message', 'error');
                  break;
                }
                state.attachments.push(message.payload.attachments[fai]);
              }
              renderAttachmentPreviews();
            }
            break;

          case 'suggestionsLoading':
            showSuggestionSkeleton();
            break;
          case 'suggestionsReady':
            renderSuggestions(message.payload.suggestions);
            break;
          case 'suggestionsError':
            // Clear suggestions on error - don't show fallbacks
            var suggestionsContainer = document.getElementById('quick-actions');
            if (suggestionsContainer) {
              suggestionsContainer.classList.remove('loading');
              suggestionsContainer.innerHTML = '';
            }
            break;
          case 'clearSuggestions':
            // Clear suggestions when user interacts with questions/plans
            var suggestionsContainer = document.getElementById('quick-actions');
            if (suggestionsContainer) {
              suggestionsContainer.classList.remove('loading');
              suggestionsContainer.innerHTML = '';
            }
            break;
          case 'clearPlanOptions':
            // Clear plan options and questions when exiting plan mode
            var planOptionsContainers = document.querySelectorAll('.plan-options-container');
            planOptionsContainers.forEach(function(container) {
              container.remove();
            });
            var questionsContainers = document.querySelectorAll('.ask-user-question-container');
            questionsContainers.forEach(function(container) {
              container.remove();
            });
            console.log('[Mysti] Cleared all plan options and questions from UI');
            break;
          case 'autocompleteSuggestion':
            if (message.payload && message.payload.suggestion) {
              updateGhostText(message.payload.suggestion);
              state.autocompleteType = message.payload.type || 'word';
            }
            break;
          case 'autocompleteCleared':
            if (autocompleteGhostEl) {
              autocompleteGhostEl.innerHTML = '';
            }
            state.autocompleteSuggestion = null;
            state.autocompleteType = null;
            break;
          case 'toolUse':
            handleToolUse(message.payload);
            break;
          case 'toolResult':
            handleToolResult(message.payload);
            break;
          case 'channelAction':
            handleChannelAction(message.payload);
            break;
          case 'connectionRequired':
            handleConnectionRequired(message.payload);
            break;
          case 'connectionAlready':
            handleConnectionAlready(message.payload);
            break;
          case 'connectionResult':
            handleConnectionResult(message.payload);
            break;
          case 'permissionRequest':
            handlePermissionRequest(message.payload);
            break;
          case 'permissionExpired':
            handlePermissionExpired(message.payload);
            break;
          case 'permissionDismissed':
            // Remove all pending permission cards (new message superseded the old request)
            document.querySelectorAll('.permission-card.pending').forEach(function(card) {
              card.classList.remove('pending');
              card.classList.add('expired');
              var actionsEl = card.querySelector('.permission-actions');
              if (actionsEl) {
                actionsEl.innerHTML = '<span style="color: var(--vscode-descriptionForeground);">Cancelled — new message sent</span>';
              }
            });
            break;
          case 'semiAutonomousDecision':
            handleSemiAutonomousDecision(message.payload);
            break;
          case 'semiAutonomousQuestionTimer':
            handleSemiAutoQuestionTimer(message.payload);
            break;
          case 'semiAutonomousPlanTimer':
            handleSemiAutoPlanTimer(message.payload);
            break;
          case 'planOptions':
            handlePlanOptionsMessage(message.payload);
            break;
          case 'askUserQuestion':
            handleAskUserQuestionMessage(message.payload);
            break;
          case 'error':
            hideLoading();
            showError(message.payload);
            break;
          case 'authError':
            hideLoading();
            showAuthError(message.payload);
            break;
          case 'contextUpdated':
            updateContext(message.payload);
            break;
          case 'workspaceFiles':
            state.workspaceFileCache = message.payload || [];
            break;
          case 'conversationChanged':
            clearMessages();
            resetContextUsage();
            // Keep the conversation for legacy attribution fallback —
            // messages without a per-message provider/model stamp fall back
            // to the conversation's values (Plan 02 Phase 3.4).
            state.conversation = message.payload || null;
            if (message.payload && message.payload.messages) {
              message.payload.messages.forEach(function(msg) { addMessage(msg); });
            }
            // Update agent config when switching conversations
            if (message.payload && message.payload.agentConfig) {
              state.agentConfig = message.payload.agentConfig;
            } else {
              state.agentConfig = { personaId: null, enabledSkills: [] };
            }
            renderAgentConfigPanel();
            break;
          case 'agentConfigUpdated':
            // Update local state with new config (e.g., from quick action auto-selection)
            if (message.payload) {
              state.agentConfig = {
                personaId: message.payload.personaId || null,
                enabledSkills: message.payload.enabledSkills || []
              };
              renderAgentConfigPanel();
            }
            break;
          case 'agentRecommendations':
            renderRecommendations(message.payload);
            break;
          case 'conversationHistory':
            renderHistoryMenu(message.payload.conversations, message.payload.currentId);
            break;
          case 'titleUpdated':
            // Title was updated by AI, refresh history if open
            if (historyMenu && !historyMenu.classList.contains('hidden')) {
              postMessageWithPanelId({ type: 'getConversationHistory' });
            }
            break;
          case 'insertPrompt':
            inputEl.value = message.payload;
            inputEl.focus();
            break;
          case 'setInputValue':
            inputEl.value = message.payload;
            inputEl.focus();
            // Trigger input event to activate @-mention or slash menu detection
            inputEl.dispatchEvent(new Event('input'));
            break;
          case 'promptEnhanced':
            // Clear safety timeout
            if (enhanceTimeout) {
              clearTimeout(enhanceTimeout);
              enhanceTimeout = null;
            }
            // Reset enhancing state
            enhanceBtn.classList.remove('enhancing');
            enhanceBtn.title = 'Enhance prompt';
            var inputAreaReset = document.querySelector('.input-area');
            if (inputAreaReset) inputAreaReset.classList.remove('enhancing');

            inputEl.value = message.payload;
            inputEl.focus();
            autoResizeTextarea();
            break;
          case 'promptEnhanceError':
            // Clear safety timeout
            if (enhanceTimeout) {
              clearTimeout(enhanceTimeout);
              enhanceTimeout = null;
            }
            // Reset enhancing state on error
            enhanceBtn.classList.remove('enhancing');
            enhanceBtn.title = 'Enhance prompt';
            var inputAreaError = document.querySelector('.input-area');
            if (inputAreaError) inputAreaError.classList.remove('enhancing');

            // Show error briefly in the input area
            var originalPlaceholder = inputEl.placeholder;
            inputEl.placeholder = 'Enhancement failed: ' + (message.payload || 'Try again');
            setTimeout(function() {
              inputEl.placeholder = originalPlaceholder;
            }, 3000);
            inputEl.focus();
            break;
          case 'slashCommandMenu':
            renderSlashMenu(message.payload);
            break;
          case 'slashCommandResult':
            addSystemMessage(message.payload.result);
            break;
          case 'sessionCleared':
            sessionIndicator.style.display = 'none';
            sessionIndicator.className = 'session-indicator';
            break;
          case 'sessionActive':
            sessionIndicator.style.display = 'flex';
            sessionIndicator.className = 'session-indicator';
            break;
          case 'lifecycleEvent':
            handleLifecycleEvent(message.payload);
            break;
          case 'fileReverted':
            handleFileReverted(message.payload);
            break;
          case 'fileLineNumber':
            handleFileLineNumber(message.payload);
            break;
          // Brainstorm mode message handlers
          case 'brainstormStarted':
            handleBrainstormStarted(message.payload);
            break;
          case 'brainstormAgentChunk':
            handleBrainstormAgentChunk(message.payload);
            break;
          case 'brainstormPhaseChange':
            handleBrainstormPhaseChange(message.payload);
            break;
          case 'brainstormSynthesisChunk':
            handleBrainstormSynthesisChunk(message.payload);
            break;
          case 'brainstormComplete':
            handleBrainstormComplete(message.payload);
            break;
          case 'brainstormError':
            handleBrainstormError(message.payload);
            break;
          case 'brainstormAgentComplete':
            handleBrainstormAgentComplete(message.payload);
            break;
          case 'brainstormDiscussionRoundStart':
            state.currentDiscussionRound = message.payload.roundNumber;
            handleBrainstormDiscussionRoundStart(message.payload);
            break;
          case 'brainstormDiscussionChunk':
            handleBrainstormDiscussionChunk(message.payload);
            break;
          case 'brainstormConvergenceUpdate':
            handleBrainstormConvergenceUpdate(message.payload);
            break;
          case 'brainstormDiscussionError':
            handleBrainstormDiscussionError(message.payload);
            break;
          case 'brainstormAgentError':
            handleBrainstormAgentErrorEvent(message.payload);
            break;
          case 'agentChanged':
            state.activeAgent = message.payload.agent;
            state.settings.provider = message.payload.agent;
            // Sync provider dropdown
            if (providerSelect) providerSelect.value = message.payload.agent;
            updateAgentMenuSelection();
            break;
          case 'modelChanged':
            // Update model dropdown when backend auto-switches model (e.g. provider change)
            state.settings.model = message.payload.model;
            if (modelSelect) modelSelect.value = message.payload.model;
            break;
          case 'modeChanged':
            // Update mode when plan is executed
            var newMode = message.payload.mode;
            state.settings.mode = newMode;
            var modeSelect = document.getElementById('mode-select');
            if (modeSelect) modeSelect.value = newMode;
            updateBehaviorIndicator();
        updateBehaviorHint();
            break;
          case 'setInputValue':
            // For "Keep Planning" - insert prompt into input field
            inputEl.value = message.payload.value;
            autoResizeTextarea();
            inputEl.focus();
            break;
          // Setup message handlers
          case 'setupStatus':
            handleSetupStatus(message.payload);
            break;
          case 'setupProgress':
            handleSetupProgress(message.payload);
            break;
          case 'setupComplete':
            handleSetupComplete(message.payload);
            break;
          case 'setupFailed':
            handleSetupFailed(message.payload);
            break;
          case 'authPrompt':
            handleAuthPrompt(message.payload);
            break;
          // Setup Wizard handlers (enhanced onboarding)
          case 'showWizard':
            handleShowWizard(message.payload);
            break;
          case 'wizardStatus':
            handleWizardStatus(message.payload);
            break;
          case 'providerSetupStep':
            handleProviderSetupStep(message.payload);
            break;
          case 'authOptions':
            handleAuthOptions(message.payload);
            break;
          case 'providerInstallInfo':
            handleProviderInstallInfo(message.payload);
            break;
          case 'wizardComplete':
            handleWizardComplete(message.payload);
            break;
          case 'wizardDismissed':
            handleWizardDismissed();
            break;
          case 'diagnosticsResult':
            handleDiagnosticsResult(message.payload);
            break;

          // ---- Autonomous Mode Messages ----

          case 'showAutonomousConfirm':
            {
              var overlay = document.getElementById('autonomous-confirm-overlay');
              var goalInput = document.getElementById('autonomous-goal-input');
              if (overlay) overlay.classList.remove('hidden');
              if (goalInput) goalInput.value = '';
              if (goalInput) goalInput.focus();
            }
            break;

          case 'autonomousActivated':
            {
              state.autonomyLevel = 'autonomous';
              var aSelect = document.getElementById('autonomy-select');
              if (aSelect) aSelect.value = 'autonomous';
              var popupASelect = document.getElementById('popup-autonomy-select');
              if (popupASelect) popupASelect.value = 'autonomous';
              showAutonomySubSettings('autonomous');
              updateAutonomyIndicator();
              updateBehaviorIndicator();
            }
            break;

          case 'autonomousDeactivated':
            {
              // If payload has stats, it was a real deactivation — go back to manual
              if (message.payload && message.payload.totalDecisions !== undefined) {
                state.autonomyLevel = 'manual';
                var aSelect = document.getElementById('autonomy-select');
                if (aSelect) aSelect.value = 'manual';
                var popupASelect = document.getElementById('popup-autonomy-select');
                if (popupASelect) popupASelect.value = 'manual';
                showAutonomySubSettings('manual');
                // Restore manual timeout behavior
                var tbSelect = document.getElementById('timeout-behavior-select');
                var tbValue = tbSelect ? tbSelect.value : 'auto-reject';
                postMessageWithPanelId({ type: 'updateSettings', payload: { 'permission.timeoutBehavior': tbValue } });
                // Show stats summary
                if (message.payload.totalDecisions > 0) {
                  var statsText = 'Autonomous session ended: ' +
                    message.payload.permissionsApproved + ' approved, ' +
                    message.payload.actionsBlocked + ' blocked, ' +
                    message.payload.questionsAnswered + ' questions answered, ' +
                    message.payload.tasksCompleted + ' tasks completed.';
                  console.log('[Mysti] ' + statsText);
                  var feedEl = document.getElementById('autonomous-decision-feed');
                  if (feedEl) feedEl.remove();
                }
              } else {
                // Cancelled confirmation — revert to previous level
                state.autonomyLevel = state.previousAutonomyLevel;
                var aSelect = document.getElementById('autonomy-select');
                if (aSelect) aSelect.value = state.autonomyLevel;
                var popupASelect = document.getElementById('popup-autonomy-select');
                if (popupASelect) popupASelect.value = state.autonomyLevel;
                showAutonomySubSettings(state.autonomyLevel);
              }
              updateAutonomyIndicator();
              updateBehaviorIndicator();
            }
            break;

          case 'autonomousDecision':
            {
              var payload = message.payload;
              var feedContainer = document.getElementById('autonomous-decision-feed');
              if (!feedContainer) {
                feedContainer = document.createElement('div');
                feedContainer.id = 'autonomous-decision-feed';
                feedContainer.style.maxHeight = '120px';
                feedContainer.style.overflowY = 'auto';
                var messagesContainer = document.getElementById('messages');
                if (messagesContainer) messagesContainer.parentNode.insertBefore(feedContainer, messagesContainer);
              }
              var card = document.createElement('div');
              card.className = 'autonomous-decision-card' + (payload.safetyLevel === 'blocked' ? ' blocked' : payload.safetyLevel === 'caution' ? ' caution' : '');
              var icon = payload.safetyLevel === 'blocked' ? '&#x2717;' : payload.safetyLevel === 'caution' ? '&#x26A0;' : '&#x2713;';
              card.innerHTML = '<span>' + icon + '</span><span class="decision-text">' + escapeHtml(payload.description) + '</span><span class="decision-time">now</span>';
              feedContainer.appendChild(card);
              feedContainer.scrollTop = feedContainer.scrollHeight;
              // Limit visible cards
              while (feedContainer.children.length > 20) {
                feedContainer.removeChild(feedContainer.firstChild);
              }
            }
            break;

          case 'auditLog':
            // Could render a full audit log panel. For now, log to console.
            console.log('[Mysti] Audit log:', message.payload);
            break;

          case 'autonomousStats':
            console.log('[Mysti] Autonomous stats:', message.payload);
            break;

          // --- Active Mode ---
          case 'activeModeStatus':
            handleActiveModeStatus(message.payload);
            break;
          case 'activeModeChannels':
            handleActiveModeChannels(message.payload);
            break;
          case 'activeModeActivity':
            handleActiveModeActivity(message.payload);
            break;
          case 'daemonStartResult':
            handleDaemonStartResult(message.payload);
            break;
          case 'exportResult':
            handleExportResult(message.payload);
            break;
          case 'triggerExport':
            postMessageWithPanelId({ type: 'exportConversation' });
            break;
          case 'triggerImport':
            postMessageWithPanelId({ type: 'importFromFile' });
            break;
          case 'openVisualTestDialog':
            // Redirect to opening the dashboard in a separate tab
            postMessageWithPanelId({ type: 'openVisualTestDashboard' });
            break;
          case 'visualTestMiniStatus':
            handleVisualTestMiniStatus(message.payload);
            break;
          case 'badgeUnlocked': {
            var badge = message.payload;
            var toastIcon = document.getElementById('badge-toast-icon');
            var toastTier = document.getElementById('badge-toast-tier');
            var toastTitle = document.getElementById('badge-toast-title');
            var toastSubtitle = document.getElementById('badge-toast-subtitle');
            var toastEl = document.getElementById('badge-toast');
            if (toastIcon && toastTier && toastTitle && toastSubtitle && toastEl) {
              toastIcon.textContent = badge.icon;
              toastTier.textContent = badge.tier;
              toastTier.className = 'badge-toast-tier ' + badge.tier;
              toastTitle.textContent = "You've been Mysting! " + badge.name;
              toastSubtitle.textContent = badge.description;
              toastEl.classList.add('show');
              setTimeout(function() { toastEl.classList.remove('show'); }, 6000);
            }
            break;
          }
          case 'badgesUpdate': {
            var data = message.payload;
            updateBadgesUI(data.badges, data.counts);
            // Also update stats
            if (data.stats) {
              var convEl = document.getElementById('stat-conversations');
              var msgEl = document.getElementById('stat-messages');
              var brainEl = document.getElementById('stat-brainstorms');
              var streakEl = document.getElementById('stat-streak');
              if (convEl) convEl.textContent = String(data.stats.totalConversations || 0);
              if (msgEl) msgEl.textContent = String(data.stats.totalMessages || 0);
              if (brainEl) brainEl.textContent = String(data.stats.totalBrainstorms || 0);
              if (streakEl) streakEl.textContent = String(data.stats.dayStreak || 0);
            }
            break;
          }
          case 'badgeShareCopied': {
            showExportToast('Badge share text copied to clipboard!');
            break;
          }
        }
      }

      // ========================================
      // Active Mode Handlers
      // ========================================

      function handleActiveModeStatus(payload) {
        const strip = document.getElementById('active-mode-strip');
        const dot = document.getElementById('active-mode-dot');
        const label = document.getElementById('active-mode-label');
        const daemonActions = document.getElementById('active-mode-daemon-actions');
        const headerBtn = document.getElementById('active-mode-btn');
        const headerDot = document.getElementById('active-mode-btn-dot');
        if (!strip || !dot || !label) return;

        if (!payload.installed) {
          strip.style.display = 'none';
          if (headerBtn) headerBtn.style.display = 'none';
          return;
        }

        strip.style.display = 'block';
        if (headerBtn) headerBtn.style.display = '';
        const status = payload.status;
        if (status && status.running) {
          dot.classList.add('connected');
          const chCount = status.channelCount || 0;
          label.textContent = 'OpenClaw Active' + (chCount > 0 ? ' \u00B7 ' + chCount + ' channel' + (chCount !== 1 ? 's' : '') : '');
          if (daemonActions) daemonActions.style.display = 'none';
          if (headerDot) { headerDot.className = 'active-mode-btn-dot connected'; }
        } else {
          dot.classList.remove('connected');
          label.textContent = 'OpenClaw Offline';
          if (daemonActions) daemonActions.style.display = 'block';
          if (headerDot) { headerDot.className = 'active-mode-btn-dot offline'; }
        }
      }

      function handleActiveModeChannels(channels) {
        const container = document.getElementById('active-mode-channels');
        if (!container) return;

        if (!channels || channels.length === 0) {
          container.innerHTML = '<div class="active-mode-empty">No channels connected</div>';
          return;
        }

        container.innerHTML = channels.map(function(ch) {
          var meta = ch.metadata || {};
          var identifier = meta.phoneNumber || meta.botUsername || meta.workspaceName || ch.name || '';
          var timeAgo = ch.lastActivity ? formatTimeAgo(ch.lastActivity) : '';
          return '<div class="active-mode-channel-row">' +
            '<span class="active-mode-channel-dot ' + (ch.status || 'disconnected') + '"></span>' +
            '<span class="active-mode-channel-name">' + escapeHtml(ch.type) + (identifier ? ' \u00B7 ' + escapeHtml(identifier) : '') + '</span>' +
            (timeAgo ? '<span class="active-mode-channel-meta">' + timeAgo + '</span>' : '') +
            '<button class="active-mode-channel-disconnect" data-channel-id="' + escapeHtml(ch.id) + '" title="Disconnect">\u00D7</button>' +
          '</div>';
        }).join('');

        // Bind disconnect buttons
        container.querySelectorAll('.active-mode-channel-disconnect').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var channelId = btn.getAttribute('data-channel-id');
            if (channelId) {
              vscode.postMessage({ type: 'disconnectChannel', payload: { channelId: channelId }, panelId: state.panelId });
            }
          });
        });
      }

      function handleActiveModeActivity(entry) {
        var container = document.getElementById('active-mode-activity');
        if (!container) return;

        // Remove empty placeholder if present
        var empty = container.querySelector('.active-mode-empty');
        if (empty) empty.remove();

        var el = document.createElement('div');
        el.className = 'active-mode-activity-entry';
        var time = new Date(entry.timestamp);
        el.innerHTML =
          '<span class="active-mode-activity-time">' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' +
          '<span class="active-mode-activity-source">' + escapeHtml(entry.source) + '</span>' +
          '<span class="active-mode-activity-action">' + escapeHtml(entry.action) + '</span>';
        container.insertBefore(el, container.firstChild);

        // Keep max 50 entries
        while (container.children.length > 50) {
          container.removeChild(container.lastChild);
        }
      }



      function handleDaemonStartResult(payload) {
        if (payload.success) {
          // Refresh will happen via activeModeStatus event
          console.log('[Mysti] Daemon started successfully');
        } else {
          var daemonActions = document.getElementById('active-mode-daemon-actions');
          if (daemonActions) {
            daemonActions.innerHTML = '<button class="active-mode-start-btn" id="active-mode-start-daemon">Start Daemon</button>' +
              '<div class="active-mode-empty" style="color: var(--vscode-testing-iconFailed);">Failed to start. Run: openclaw onboard --install-daemon</div>';
            setupActiveModeListeners();
          }
        }
      }

      // ========================================
      // Export / Copy Handlers
      // ========================================

      // ====================================================================
      // Visual Test UI Functions
      // ====================================================================

      // Visual test mini status handler (dashboard runs in separate tab)
      var vtMiniHideTimer = null;
      function handleVisualTestMiniStatus(chunk) {
        if (!chunk) return;
        var bar = document.getElementById('vt-mini-status');
        var text = document.getElementById('vt-mini-status-text');
        if (!bar || !text) return;

        bar.classList.remove('hidden');
        if (vtMiniHideTimer) { clearTimeout(vtMiniHideTimer); vtMiniHideTimer = null; }

        switch (chunk.type) {
          case 'visual_test_started':
            text.textContent = 'Visual Test: ' + (chunk.message || 'Starting...');
            break;
          case 'visual_test_screenshot':
            text.textContent = 'Visual Test: Screenshot captured (iteration ' + (chunk.screenshot ? chunk.screenshot.iteration : '?') + ')';
            break;
          case 'visual_test_fix':
            text.textContent = 'Visual Test: ' + (chunk.message || 'Applying fix...');
            break;
          case 'visual_test_iteration':
            if (chunk.iteration) {
              text.textContent = 'Visual Test: Iteration ' + chunk.iteration.number + ' complete';
            }
            break;
          case 'visual_test_error':
            text.textContent = 'Visual Test: Error — ' + (chunk.message || 'Unknown');
            vtMiniHideTimer = setTimeout(function() { bar.classList.add('hidden'); }, 8000);
            break;
          case 'visual_test_complete': {
            var verdict = chunk.report && chunk.report.summary ? chunk.report.summary.verdict : 'fail';
            text.textContent = 'Visual Test: Complete — ' + verdict.toUpperCase();
            vtMiniHideTimer = setTimeout(function() { bar.classList.add('hidden'); }, 5000);
            break;
          }
          default:
            if (chunk.message) { text.textContent = 'Visual Test: ' + chunk.message; }
            break;
        }
      }

      // Wire up canvas button → opens canvas in separate tab
      (function() {
        var canvasBtn = document.getElementById('canvas-btn');
        if (canvasBtn) {
          canvasBtn.addEventListener('click', function() {
            postMessageWithPanelId({ type: 'openCanvas' });
          });
        }
      })();

      // Wire up visual test button → opens dashboard in separate tab
      (function() {
        var vtBtn = document.getElementById('visual-test-btn');
        if (vtBtn) {
          vtBtn.addEventListener('click', function() {
            postMessageWithPanelId({ type: 'openVisualTestDashboard' });
          });
        }
        // Mini status cancel button
        var vtMiniCancel = document.getElementById('vt-mini-cancel');
        if (vtMiniCancel) {
          vtMiniCancel.addEventListener('click', function() {
            postMessageWithPanelId({ type: 'cancelVisualTest' });
          });
        }
      })();

      function handleExportResult(payload) {
        var toast = document.getElementById('export-toast');
        if (!toast) return;
        if (payload && payload.success) {
          toast.textContent = 'Copied to clipboard!';
          toast.classList.add('visible');
          setTimeout(function() {
            toast.classList.remove('visible');
          }, 2000);
        } else {
          toast.textContent = 'Export failed';
          toast.classList.add('visible');
          setTimeout(function() {
            toast.classList.remove('visible');
          }, 2000);
        }
      }

      // Cache badge data for instant panel rendering
      var cachedBadges = null;
      var cachedBadgeCounts = null;

      function updateBadgesUI(badges, counts) {
        // Update cache
        cachedBadges = badges;
        cachedBadgeCounts = counts;

        var counterEl = document.getElementById('badge-counter');
        if (counterEl) {
          counterEl.textContent = counts.unlocked + '/' + counts.total;
        }

        // Hide spinner once data arrives
        var spinner = document.getElementById('badges-spinner');
        if (spinner) { spinner.classList.add('hidden'); }

        var grid = document.getElementById('badges-grid');
        if (!grid) { return; }
        grid.innerHTML = '';

        for (var i = 0; i < badges.length; i++) {
          var b = badges[i];
          var item = document.createElement('div');
          item.className = 'badge-item' + (b.unlocked ? '' : ' locked');

          var icon = document.createElement('span');
          icon.className = 'badge-icon';
          icon.textContent = b.icon;
          item.appendChild(icon);

          var name = document.createElement('span');
          name.className = 'badge-name';
          name.textContent = b.name;
          item.appendChild(name);

          // Progress bar for locked badges
          if (!b.unlocked && b.progressMax && b.progressMax > 0) {
            var bar = document.createElement('div');
            bar.className = 'badge-progress-bar';
            var fill = document.createElement('div');
            fill.className = 'badge-progress-fill ' + b.tier;
            fill.style.width = Math.min(100, Math.round((b.progress || 0) / b.progressMax * 100)) + '%';
            bar.appendChild(fill);
            item.appendChild(bar);
          }

          // Rich tooltip
          var tooltip = document.createElement('div');
          tooltip.className = 'badge-tooltip';

          var titleRow = document.createElement('div');
          titleRow.className = 'badge-tooltip-title';
          titleRow.textContent = b.name;
          var tierTag = document.createElement('span');
          tierTag.className = 'badge-tooltip-tier ' + b.tier;
          tierTag.textContent = b.tier;
          titleRow.appendChild(tierTag);
          tooltip.appendChild(titleRow);

          var howTo = document.createElement('div');
          howTo.className = 'badge-tooltip-howto';
          howTo.textContent = b.howTo || b.description;
          tooltip.appendChild(howTo);

          if (b.unlocked) {
            var unlockedLine = document.createElement('div');
            unlockedLine.className = 'badge-tooltip-unlocked';
            var d = new Date(b.unlockedAt);
            unlockedLine.textContent = 'Unlocked ' + d.toLocaleDateString() + ' — click to share';
            tooltip.appendChild(unlockedLine);
          } else if (b.progressMax && b.progressMax > 0) {
            var progressLine = document.createElement('div');
            progressLine.className = 'badge-tooltip-progress';
            progressLine.textContent = 'Progress: ' + (b.progress || 0) + ' / ' + b.progressMax;
            tooltip.appendChild(progressLine);
          }

          item.appendChild(tooltip);

          // Share button for unlocked badges
          if (b.unlocked) {
            (function(badgeId) {
              item.addEventListener('click', function() {
                postMessageWithPanelId({ type: 'getBadgeShareText', payload: { badgeId: badgeId } });
              });
            })(b.id);
          }

          grid.appendChild(item);
        }
      }

      function showExportToast(text) {
        var toast = document.getElementById('export-toast');
        if (!toast) return;
        toast.textContent = text;
        toast.classList.add('visible');
        setTimeout(function() {
          toast.classList.remove('visible');
        }, 2000);
      }

      function formatTimeAgo(timestamp) {
        var diff = Date.now() - timestamp;
        if (diff < 60000) return 'now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
        return Math.floor(diff / 86400000) + 'd';
      }

      function setupActiveModeListeners() {
        // Header button toggles the panel body open/closed
        var headerBtn = document.getElementById('active-mode-btn');
        if (headerBtn) {
          headerBtn.onclick = function() {
            var body = document.getElementById('active-mode-body');
            var toggle = document.getElementById('active-mode-toggle');
            var strip = document.getElementById('active-mode-strip');
            if (body && toggle && strip) {
              // Ensure strip is visible
              strip.style.display = 'block';
              var hidden = body.style.display === 'none';
              body.style.display = hidden ? 'block' : 'none';
              toggle.classList.toggle('expanded', hidden);
              // Scroll strip into view
              if (hidden) strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          };
        }

        // Toggle expand/collapse
        var header = document.getElementById('active-mode-header');
        if (header) {
          header.onclick = function() {
            var body = document.getElementById('active-mode-body');
            var toggle = document.getElementById('active-mode-toggle');
            if (body && toggle) {
              var hidden = body.style.display === 'none';
              body.style.display = hidden ? 'block' : 'none';
              toggle.classList.toggle('expanded', hidden);
            }
          };
        }

        // Integration toggle button
        var integrationToggle = document.getElementById('active-mode-integration-toggle');
        if (integrationToggle) {
          integrationToggle.onclick = function(e) {
            e.stopPropagation();
            var isOn = integrationToggle.classList.contains('on');
            var newState = !isOn;
            integrationToggle.classList.toggle('on', newState);
            integrationToggle.textContent = newState ? 'ON' : 'OFF';
            vscode.postMessage({ type: 'toggleIntegration', payload: { enabled: newState }, panelId: state.panelId });
          };
        }

        // Connect channel button — opens a terminal for interactive OpenClaw setup
        var connectBtn = document.getElementById('active-mode-connect-btn');
        if (connectBtn) {
          connectBtn.onclick = function() {
            vscode.postMessage({ type: 'connectChannel', payload: { channelType: 'channels' }, panelId: state.panelId });
          };
        }

        // Start daemon button
        var startBtn = document.getElementById('active-mode-start-daemon');
        if (startBtn) {
          startBtn.onclick = function() {
            vscode.postMessage({ type: 'startDaemon', panelId: state.panelId });
            startBtn.textContent = 'Starting...';
            startBtn.disabled = true;
          };
        }

        // Detect connection button
        var detectBtn = document.getElementById('active-mode-detect');
        if (detectBtn) {
          detectBtn.onclick = function() {
            vscode.postMessage({ type: 'refreshActiveMode', panelId: state.panelId });
            detectBtn.textContent = 'Detecting...';
            detectBtn.disabled = true;
            setTimeout(function() {
              detectBtn.textContent = 'Detect Connection';
              detectBtn.disabled = false;
            }, 3000);
          };
        }
      }

      // --- Active Mode auto-refresh ---
      var _activeModeRefreshTimer = null;

      function startActiveModeAutoRefresh() {
        stopActiveModeAutoRefresh();
        // Refresh every 5 seconds while the panel body is visible
        _activeModeRefreshTimer = setInterval(function() {
          var body = document.getElementById('active-mode-body');
          if (body && body.style.display !== 'none') {
            vscode.postMessage({ type: 'refreshActiveMode', panelId: state.panelId });
          }
        }, 5000);
      }

      function stopActiveModeAutoRefresh() {
        if (_activeModeRefreshTimer) {
          clearInterval(_activeModeRefreshTimer);
          _activeModeRefreshTimer = null;
        }
      }

      // Initialize active mode listeners on load
      setupActiveModeListeners();
      startActiveModeAutoRefresh();

      // ========================================
      // Setup Flow Handlers (Legacy)
      // ========================================

      function handleSetupStatus(payload) {
        state.setup.providers = payload.providers;
        state.setup.npmAvailable = payload.npmAvailable;
        state.setup.isReady = payload.anyReady;

        if (payload.anyReady) {
          hideSetupOverlay();
        }
      }

      function handleSetupProgress(payload) {
        state.setup.currentStep = payload.step;
        state.setup.providerId = payload.providerId;
        state.setup.message = payload.message;
        state.setup.progress = payload.progress || 0;
        state.setup.isChecking = false;

        updateSetupOverlay();
      }

      function handleSetupComplete(payload) {
        state.setup.isReady = true;
        state.setup.currentStep = 'ready';
        state.setup.message = 'Setup complete!';
        state.setup.error = null;

        // Hide setup after brief success display
        setTimeout(function() {
          hideSetupOverlay();
        }, 1000);
      }

      function handleSetupFailed(payload) {
        state.setup.currentStep = 'failed';
        state.setup.providerId = payload.providerId;
        state.setup.error = payload.error;
        state.setup.message = payload.error;

        updateSetupOverlay();
      }

      function handleAuthPrompt(payload) {
        state.setup.currentStep = 'authenticating';
        state.setup.providerId = payload.providerId;
        state.setup.message = payload.message;

        showAuthPromptUI(payload);
      }

      function showSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (overlay) {
          overlay.classList.remove('hidden');
        }
      }

      function hideSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (overlay) {
          overlay.classList.add('hidden');
        }
        state.setup.isReady = true;
      }

      function updateSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');

        var progressEl = overlay.querySelector('.setup-progress-bar');
        var messageEl = overlay.querySelector('.setup-message');
        var stepEl = overlay.querySelector('.setup-step');

        if (progressEl) {
          progressEl.style.width = state.setup.progress + '%';
        }
        if (messageEl) {
          messageEl.textContent = state.setup.message;
        }
        if (stepEl) {
          var stepText = state.setup.currentStep === 'checking' ? 'Checking...' :
                         state.setup.currentStep === 'installing' ? 'Installing...' :
                         state.setup.currentStep === 'authenticating' ? 'Authenticating...' :
                         state.setup.currentStep === 'ready' ? 'Ready!' :
                         state.setup.currentStep === 'failed' ? 'Setup Failed' : '';
          stepEl.textContent = stepText;
        }

        // Show error UI if failed
        if (state.setup.currentStep === 'failed') {
          var errorSection = overlay.querySelector('.setup-error');
          if (errorSection) {
            errorSection.classList.remove('hidden');
            var errorMsg = errorSection.querySelector('.setup-error-message');
            if (errorMsg) errorMsg.textContent = state.setup.error;
          }
        }
      }

      function showAuthPromptUI(payload) {
        var overlay = document.getElementById('setup-overlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');
        var content = overlay.querySelector('.setup-content');
        if (!content) return;

        content.innerHTML =
          '<div class="setup-auth-prompt">' +
            '<div class="setup-icon">🔐</div>' +
            '<div class="setup-step">Authentication Required</div>' +
            '<div class="setup-message">' + payload.message + '</div>' +
            '<div class="setup-buttons">' +
              '<button class="setup-btn primary" id="auth-confirm-btn">Sign In</button>' +
              '<button class="setup-btn secondary" id="auth-skip-btn">Later</button>' +
            '</div>' +
          '</div>';

        document.getElementById('auth-confirm-btn').addEventListener('click', function() {
          postMessageWithPanelId({ type: 'authConfirm', payload: { providerId: payload.providerId } });
          content.innerHTML =
            '<div class="setup-progress">' +
              '<div class="setup-icon">⏳</div>' +
              '<div class="setup-step">Waiting for authentication...</div>' +
              '<div class="setup-message">Complete sign-in in the terminal that opened</div>' +
            '</div>';
        });

        document.getElementById('auth-skip-btn').addEventListener('click', function() {
          postMessageWithPanelId({ type: 'authSkip', payload: { providerId: payload.providerId } });
        });
      }

      // ========================================
      // Setup Wizard Handlers (Enhanced Onboarding)
      // ========================================

      function handleShowWizard(payload) {
        dismissInitLoading();
        // B2: the wizard is shown instead of initialState, so this payload is
        // the only chance to learn our panelId. Without it every outgoing
        // wizard message carries panelId=null and replies are dropped.
        if (payload.panelId) {
          state.panelId = payload.panelId;
        }
        state.wizard.visible = true;
        state.wizard.providers = payload.providers || [];
        state.wizard.npmAvailable = payload.npmAvailable;
        state.wizard.nodeVersion = payload.nodeVersion;
        state.wizard.anyReady = payload.anyReady;

        renderWizard();
        initWizardEventListeners();
      }

      function handleWizardStatus(payload) {
        state.wizard.providers = payload.providers || [];
        state.wizard.npmAvailable = payload.npmAvailable;
        state.wizard.anyReady = payload.anyReady;

        if (state.wizard.visible) {
          updateWizardProviderCards();
        }
      }

      function handleProviderSetupStep(payload) {
        // Update provider in state
        var provider = state.wizard.providers.find(function(p) {
          return p.providerId === payload.providerId;
        });

        if (provider) {
          provider.setupStep = payload.step;
          provider.setupProgress = payload.progress;
          provider.setupMessage = payload.message;
          provider.setupDetails = payload.details;

          if (payload.step === 'complete') {
            provider.installed = true;
            provider.authenticated = true;
            provider.errorCategory = null;
            provider.suggestedFix = null;
            provider.retryable = false;
            provider.alternativeCommands = null;
          } else if (payload.step === 'failed') {
            provider.lastError = payload.message;
            provider.errorCategory = payload.errorCategory || null;
            provider.suggestedFix = payload.suggestedFix || null;
            provider.retryable = payload.retryable !== false;
            provider.alternativeCommands = payload.alternativeCommands || null;
          }
        }

        updateWizardProviderCard(payload.providerId);

        // Also update install modal if it's open for this provider
        if (currentInstallProviderId === payload.providerId) {
          updateInstallProgress(payload);
        }
      }

      function handleAuthOptions(payload) {
        state.wizard.currentAuthProviderId = payload.providerId;
        showAuthOptionsModal(payload);
      }

      function handleWizardComplete(payload) {
        hideWizard();
        // Main UI will be shown via initialState
      }

      function handleWizardDismissed() {
        hideWizard();
        // Main UI will be shown via initialState
      }

      function renderWizard() {
        var wizard = document.getElementById('setup-wizard');
        if (!wizard) return;

        wizard.classList.remove('hidden');

        // Show/hide prerequisites warning
        var prereqSection = document.getElementById('wizard-prerequisites');
        if (prereqSection) {
          if (state.wizard.npmAvailable) {
            prereqSection.classList.add('hidden');
          } else {
            prereqSection.classList.remove('hidden');
          }
        }

        // Update provider cards
        updateWizardProviderCards();
      }

      function updateWizardProviderCards() {
        state.wizard.providers.forEach(function(provider) {
          updateWizardProviderCard(provider.providerId);
        });
      }

      function updateWizardProviderCard(providerId) {
        var card = document.querySelector('.provider-card[data-provider="' + providerId + '"]');
        if (!card) return;

        var provider = state.wizard.providers.find(function(p) {
          return p.providerId === providerId;
        });
        if (!provider) return;

        // Determine status
        var status = getWizardProviderStatus(provider);

        // Update status badge
        var statusBadge = card.querySelector('.provider-status');
        if (statusBadge) {
          statusBadge.setAttribute('data-status', status);
          statusBadge.textContent = getWizardStatusText(status);
        }

        // Update card class
        card.classList.remove('ready', 'error');
        if (status === 'ready' || status === 'complete') {
          card.classList.add('ready');
        } else if (status === 'error' || status === 'failed') {
          card.classList.add('error');
        }

        // Update progress section
        var progressSection = card.querySelector('.provider-progress');
        if (progressSection) {
          var showProgress = ['installing', 'downloading', 'verifying', 'authenticating', 'checking'].indexOf(status) !== -1;
          if (showProgress) {
            progressSection.classList.remove('hidden');
            var progressBar = progressSection.querySelector('.progress-bar');
            if (progressBar) {
              progressBar.style.width = (provider.setupProgress || 0) + '%';
            }
            var progressMsg = progressSection.querySelector('.progress-msg');
            if (progressMsg) {
              progressMsg.textContent = provider.setupMessage || 'Working...';
            }
          } else {
            progressSection.classList.add('hidden');
          }
        }

        // Update error details section
        var errorSection = card.querySelector('.provider-error-details');
        if (errorSection) {
          if (status === 'failed' && provider.lastError) {
            errorSection.classList.remove('hidden');
            renderProviderErrorDetails(errorSection, provider);
          } else {
            errorSection.classList.add('hidden');
            errorSection.innerHTML = '';
          }
        }

        // Update action button
        var actionBtn = card.querySelector('.provider-action-btn');
        if (actionBtn) {
          updateWizardActionButton(actionBtn, provider, status);
        }
      }

      function getWizardProviderStatus(provider) {
        if (provider.setupStep === 'failed') return 'failed';
        if (provider.setupStep && provider.setupStep !== 'complete') return provider.setupStep;
        if (provider.installed && provider.authenticated) return 'ready';
        if (provider.installed && !provider.authenticated) return 'not-authenticated';
        return 'not-installed';
      }

      function getWizardStatusText(status) {
        var texts = {
          'unknown': 'Checking...',
          'not-installed': 'Not Installed',
          'checking': 'Checking...',
          'downloading': 'Downloading...',
          'installing': 'Installing...',
          'verifying': 'Verifying...',
          'not-authenticated': 'Not Signed In',
          'authenticating': 'Authenticating...',
          'ready': 'Ready',
          'complete': 'Ready',
          'error': 'Error',
          'failed': 'Failed'
        };
        return texts[status] || status;
      }

      function updateWizardActionButton(btn, provider, status) {
        var supportsAutoInstall = provider.supportsAutoInstall !== false;
        var installText = supportsAutoInstall ? 'Install' : 'Set Up';
        var retryText = supportsAutoInstall ? 'Retry' : 'Set Up';

        var configs = {
          'not-installed': { text: installText, action: 'install', disabled: false, primary: true },
          'checking': { text: 'Checking...', action: null, disabled: true, primary: false },
          'downloading': { text: 'Downloading...', action: null, disabled: true, primary: false },
          'installing': { text: 'Installing...', action: null, disabled: true, primary: false },
          'verifying': { text: 'Verifying...', action: null, disabled: true, primary: false },
          'not-authenticated': { text: 'Sign In', action: 'auth', disabled: false, primary: true },
          'authenticating': { text: 'Waiting...', action: null, disabled: true, primary: false },
          'ready': { text: 'Use This', action: 'select', disabled: false, primary: true, success: true },
          'complete': { text: 'Use This', action: 'select', disabled: false, primary: true, success: true },
          'error': { text: retryText, action: 'retry', disabled: false, primary: false },
          'failed': { text: retryText, action: 'retry', disabled: false, primary: false }
        };

        var config = configs[status] || configs['not-installed'];

        btn.textContent = config.text;
        btn.disabled = config.disabled;
        btn.setAttribute('data-action', config.action || '');
        btn.setAttribute('data-provider', provider.providerId);

        btn.classList.remove('primary', 'secondary', 'success');
        if (config.success) {
          btn.classList.add('success');
        } else if (config.primary) {
          btn.classList.add('primary');
        } else {
          btn.classList.add('secondary');
        }
      }

      function renderProviderErrorDetails(container, provider) {
        var category = provider.errorCategory || 'unknown';
        var categoryLabels = {
          'permission': 'Permission',
          'network': 'Network',
          'version': 'Version',
          'not-found': 'Not Found',
          'command-failed': 'Command Failed',
          'timeout': 'Timeout',
          'unknown': 'Error'
        };

        var html = '<div class="error-detail-header">' +
          '<span class="error-category-badge ' + category + '">' + (categoryLabels[category] || 'Error') + '</span>' +
          '</div>';

        html += '<div class="error-message-text">' + escapeHtml(provider.lastError || 'Installation failed') + '</div>';

        if (provider.suggestedFix) {
          if (category === 'permission') {
            // Permission errors: render with structured sudo command and copyable blocks
            var fixLines = provider.suggestedFix.split('\n').filter(function(l) { return l.trim(); });
            html += '<div class="error-suggested-fix">' +
              '<div class="error-suggested-fix-label">Suggested Fix</div>';

            fixLines.forEach(function(line) {
              var sudoMatch = line.match(/sudo\s+(.+)/);
              var cmdMatch = line.match(/npm config set prefix\s+(\S+)/);
              if (sudoMatch) {
                // Render sudo command prominently with copy button
                var sudoCmd = 'sudo ' + sudoMatch[1];
                html += '<div class="error-alt-command-row" style="margin:6px 0;background:var(--vscode-inputValidation-errorBackground,rgba(255,0,0,0.1));">' +
                  '<code style="font-weight:600;">' + escapeHtml(sudoCmd) + '</code>' +
                  '<button class="error-alt-command-copy" data-copy-text="' + escapeHtml(sudoCmd) + '" title="Copy command">&#128203;</button>' +
                  '</div>';
              } else if (cmdMatch) {
                // Render npm config fix as copyable command
                var npmCmd = 'npm config set prefix ' + cmdMatch[1];
                html += '<div class="error-alt-command-row" style="margin:4px 0;">' +
                  '<code>' + escapeHtml(npmCmd) + '</code>' +
                  '<button class="error-alt-command-copy" data-copy-text="' + escapeHtml(npmCmd) + '" title="Copy command">&#128203;</button>' +
                  '</div>';
              } else {
                html += '<div style="margin:2px 0;">' + escapeHtml(line) + '</div>';
              }
            });

            html += '</div>';
          } else {
            html += '<div class="error-suggested-fix">' +
              '<div class="error-suggested-fix-label">Suggested Fix</div>' +
              '<div>' + escapeHtml(provider.suggestedFix) + '</div>' +
              '</div>';
          }
        }

        if (provider.alternativeCommands && provider.alternativeCommands.length > 0) {
          html += '<div class="error-alt-commands">' +
            '<div class="error-alt-commands-label">Alternative Install Methods</div>';

          provider.alternativeCommands.forEach(function(item) {
            var cmdText = typeof item === 'string' ? item : item.command;
            var cmdLabel = typeof item === 'string' ? '' : item.label;
            html += '<div class="error-alt-command-row">' +
              (cmdLabel ? '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-right:4px;">' + escapeHtml(cmdLabel) + ':</span>' : '') +
              '<code>' + escapeHtml(cmdText) + '</code>' +
              '<button class="error-alt-command-copy" data-copy-text="' + escapeHtml(cmdText) + '" title="Copy">&#128203;</button>' +
              '</div>';
          });

          html += '</div>';
        }

        container.innerHTML = html;

        // Attach copy handlers via data attributes (avoids inline onclick escaping issues)
        container.querySelectorAll('.error-alt-command-copy[data-copy-text]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            copyToClipboard(btn.getAttribute('data-copy-text') || '');
          });
        });
      }

      function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        } else {
          var textarea = document.createElement('textarea');
          textarea.value = text;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
      }

      function requestDiagnostics() {
        var btn = document.querySelector('.wizard-diagnose-btn');
        if (btn) {
          btn.textContent = '\u23F3 Running diagnostics...';
          btn.disabled = true;
        }
        postMessageWithPanelId({ type: 'runDiagnostics' });
      }

      function handleDiagnosticsResult(payload) {
        var panel = document.getElementById('diagnostics-panel');
        if (!panel) return;

        var btn = document.querySelector('.wizard-diagnose-btn');
        if (btn) {
          btn.textContent = '\uD83D\uDD0D Run Diagnostics';
          btn.disabled = false;
        }

        var result = payload;
        var html = '<h4>System Diagnostics</h4>';

        // Platform info
        html += '<div class="diagnostics-section">' +
          '<h5>Platform</h5>' +
          '<div class="diagnostics-row"><span class="label">OS</span><span class="value">' + (result.platform ? result.platform.os : 'Unknown') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">Architecture</span><span class="value">' + (result.platform ? result.platform.arch : 'Unknown') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">Shell</span><span class="value">' + (result.platform ? result.platform.shell : 'Unknown') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">NVM</span><span class="value ' + (result.platform && result.platform.hasNvm ? 'ok' : 'warn') + '">' + (result.platform && result.platform.hasNvm ? 'Detected' : 'Not found') + '</span></div>' +
          '</div>';

        // Node & npm
        html += '<div class="diagnostics-section">' +
          '<h5>Node.js & npm</h5>' +
          '<div class="diagnostics-row"><span class="label">Node.js</span><span class="value ' + (result.nodeStatus && result.nodeStatus.meetsMinimum ? 'ok' : 'error') + '">' + (result.nodeStatus && result.nodeStatus.version ? result.nodeStatus.version : 'Not found') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">npm</span><span class="value ' + (result.npmStatus && result.npmStatus.available ? 'ok' : 'error') + '">' + (result.npmStatus && result.npmStatus.version ? result.npmStatus.version : 'Not found') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">npm global dir writable</span><span class="value ' + (result.npmStatus && result.npmStatus.canWriteGlobalDir ? 'ok' : 'warn') + '">' + (result.npmStatus && result.npmStatus.canWriteGlobalDir ? 'Yes' : 'No') + '</span></div>' +
          '<div class="diagnostics-row"><span class="label">Network</span><span class="value ' + (result.networkReachable ? 'ok' : 'error') + '">' + (result.networkReachable ? 'Connected' : 'Unreachable') + '</span></div>' +
          '</div>';

        // Providers
        if (result.providers && result.providers.length > 0) {
          html += '<div class="diagnostics-section"><h5>Providers</h5>';
          result.providers.forEach(function(p) {
            var statusClass = p.installed ? (p.authenticated ? 'ok' : 'warn') : 'error';
            var statusText = p.installed ? (p.authenticated ? 'Ready' : 'Not authenticated') : 'Not installed';
            if (p.error) statusText = p.error;
            html += '<div class="diagnostics-row"><span class="label">' + escapeHtml(p.id) + '</span><span class="value ' + statusClass + '">' + escapeHtml(statusText) + (p.version ? ' (v' + escapeHtml(p.version) + ')' : '') + '</span></div>';
          });
          html += '</div>';
        }

        // Recommendations
        if (result.recommendations && result.recommendations.length > 0) {
          html += '<div class="diagnostics-section"><h5>Recommendations</h5>';
          result.recommendations.forEach(function(rec) {
            html += '<div class="diagnostics-recommendation">' + escapeHtml(rec) + '</div>';
          });
          html += '</div>';
        }

        // Copy button
        html += '<button class="diagnostics-copy-btn" onclick="copyDiagnostics()">&#128203; Copy to Clipboard</button>';

        panel.innerHTML = html;
        panel.classList.remove('hidden');

        // Store for copy
        panel.setAttribute('data-diagnostics', JSON.stringify(result, null, 2));
      }

      function copyDiagnostics() {
        var panel = document.getElementById('diagnostics-panel');
        if (!panel) return;
        var data = panel.getAttribute('data-diagnostics');
        if (data) {
          copyToClipboard(data);
          var btn = panel.querySelector('.diagnostics-copy-btn');
          if (btn) {
            btn.textContent = '\u2713 Copied!';
            setTimeout(function() { btn.textContent = '\uD83D\uDCCB Copy to Clipboard'; }, 2000);
          }
        }
      }

      function initWizardEventListeners() {
        // Provider card action buttons
        var actionBtns = document.querySelectorAll('.provider-card .provider-action-btn');
        console.log('[Mysti Webview] initWizardEventListeners: found', actionBtns.length, 'action buttons');
        actionBtns.forEach(function(btn) {
          btn.addEventListener('click', function() {
            var action = btn.getAttribute('data-action');
            var card = btn.closest('.provider-card');
            var providerId = card ? card.getAttribute('data-provider') : null;
            console.log('[Mysti Webview] Wizard button clicked - action:', action, 'providerId:', providerId);
            if (!action || !providerId) {
              console.log('[Mysti Webview] Missing action or providerId, returning early');
              return;
            }
            handleWizardProviderAction(providerId, action);
          });
        });

        // Auth options cancel button
        var authCancelBtn = document.querySelector('.auth-options-cancel');
        if (authCancelBtn) {
          authCancelBtn.addEventListener('click', function() {
            hideAuthOptionsModal();
          });
        }
      }

      function handleWizardProviderAction(providerId, action) {
        console.log('[Mysti Webview] handleWizardProviderAction:', providerId, action);

        // Check if this provider supports auto-install
        var provider = state.wizard.providers.find(function(p) { return p.providerId === providerId; });
        var supportsAutoInstall = provider ? provider.supportsAutoInstall !== false : true;

        switch (action) {
          case 'setup':
          case 'install':
          case 'retry':
            if (supportsAutoInstall) {
              postMessageWithPanelId({
                type: 'startProviderSetup',
                payload: { providerId: providerId, autoInstall: state.wizard.npmAvailable }
              });
            } else {
              // Non-auto-installable: open install modal with manual instructions
              postMessageWithPanelId({
                type: 'requestProviderInstallInfo',
                payload: { providerId: providerId }
              });
            }
            break;
          case 'auth':
            postMessageWithPanelId({
              type: 'startProviderSetup',
              payload: { providerId: providerId, autoInstall: false }
            });
            break;
          case 'select':
            postMessageWithPanelId({
              type: 'selectProvider',
              payload: { providerId: providerId }
            });
            break;
        }
      }

      function showAuthOptionsModal(payload) {
        var modal = document.getElementById('auth-options-modal');
        if (!modal) return;

        var subtitle = document.getElementById('auth-options-subtitle');
        if (subtitle) {
          subtitle.textContent = 'Select how to authenticate with ' + payload.displayName;
        }

        var optionsList = document.getElementById('auth-options-list');
        if (optionsList) {
          optionsList.innerHTML = '';

          payload.options.forEach(function(option) {
            var optionEl = document.createElement('div');
            optionEl.className = 'auth-option';
            optionEl.setAttribute('data-method', option.action);
            optionEl.innerHTML =
              '<span class="auth-option-icon">' + option.icon + '</span>' +
              '<div class="auth-option-content">' +
                '<div class="auth-option-label">' + option.label + '</div>' +
                '<div class="auth-option-desc">' + option.description + '</div>' +
              '</div>';

            optionEl.addEventListener('click', function() {
              hideAuthOptionsModal();
              postMessageWithPanelId({
                type: 'selectAuthMethod',
                payload: {
                  providerId: payload.providerId,
                  method: option.action
                }
              });
            });

            optionsList.appendChild(optionEl);
          });
        }

        modal.classList.remove('hidden');
      }

      function hideAuthOptionsModal() {
        var modal = document.getElementById('auth-options-modal');
        if (modal) {
          modal.classList.add('hidden');
        }
        state.wizard.currentAuthProviderId = null;
      }

      // ========================================
      // Install Provider Modal Functions
      // ========================================

      var currentInstallProviderId = null;

      function showInstallProviderModal(providerId) {
        console.log('[Mysti Webview] showInstallProviderModal called for:', providerId);
        currentInstallProviderId = providerId;
        // Request install info from extension
        postMessageWithPanelId({
          type: 'requestProviderInstallInfo',
          payload: { providerId: providerId }
        });
        console.log('[Mysti Webview] requestProviderInstallInfo message sent');
      }

      function handleProviderInstallInfo(payload) {
        console.log('[Mysti Webview] handleProviderInstallInfo received:', payload);
        var modal = document.getElementById('install-provider-modal');
        if (!modal) {
          console.log('[Mysti Webview] ERROR: install-provider-modal not found in DOM!');
          return;
        }
        console.log('[Mysti Webview] Modal found, updating content...');

        currentInstallProviderId = payload.providerId;

        // Update modal content
        var icon = document.getElementById('install-provider-icon');
        if (icon) {
          icon.src = getProviderIconUri(payload.providerId);
        }

        var title = document.getElementById('install-provider-title');
        if (title) {
          title.textContent = 'Install ' + payload.displayName;
        }

        var commandText = document.getElementById('install-command-text');
        if (commandText) {
          commandText.textContent = payload.installCommand;
        }

        // Auth steps
        var authList = document.getElementById('install-auth-steps');
        if (authList) {
          authList.innerHTML = '';
          payload.authInstructions.forEach(function(step) {
            var li = document.createElement('li');
            li.textContent = step;
            authList.appendChild(li);
          });
        }

        // Docs link
        var docsLink = document.getElementById('install-docs-link');
        if (docsLink) {
          if (payload.docsUrl) {
            docsLink.href = payload.docsUrl;
            docsLink.style.display = '';
          } else {
            docsLink.style.display = 'none';
          }
        }

        var autoSection = document.getElementById('install-auto-section');
        var methodsSection = document.getElementById('install-methods-section');
        var manualSection = document.getElementById('install-manual-section');
        var progressSection = document.getElementById('install-progress-section');
        if (progressSection) progressSection.classList.add('hidden');

        var supportsAutoInstall = payload.supportsAutoInstall !== false;
        var installMethods = payload.installMethods || [];

        if (supportsAutoInstall) {
          // Auto-installable provider: show auto-install button + manual fallback
          if (autoSection) autoSection.classList.remove('hidden');
          if (methodsSection) methodsSection.classList.add('hidden');
          if (manualSection) manualSection.classList.remove('hidden');
          var autoBtn = document.getElementById('install-auto-btn');
          if (autoBtn) autoBtn.disabled = false;
        } else {
          // Interactive provider: hide auto-install, show install methods
          if (autoSection) autoSection.classList.add('hidden');
          if (manualSection) manualSection.classList.add('hidden');

          if (methodsSection) {
            methodsSection.classList.remove('hidden');
            var methodsList = document.getElementById('install-methods-list');
            if (methodsList) {
              methodsList.innerHTML = '';
              var methodsToShow = installMethods.length > 0 ? installMethods : [{ id: 'default', label: 'Install', command: payload.installCommand }];
              methodsToShow.forEach(function(method) {
                var card = document.createElement('div');
                card.className = 'install-method-card';

                var label = document.createElement('p');
                label.className = 'install-method-label';
                label.textContent = method.label || 'Install';
                card.appendChild(label);

                var cmdBox = document.createElement('div');
                cmdBox.className = 'install-method-command';

                var code = document.createElement('code');
                code.textContent = method.command || '';
                cmdBox.appendChild(code);

                var copyBtn = document.createElement('button');
                copyBtn.className = 'install-copy-btn';
                copyBtn.title = 'Copy command';
                copyBtn.innerHTML = '&#128203;';
                copyBtn.setAttribute('data-copy-text', method.command || '');
                copyBtn.addEventListener('click', function() {
                  var text = copyBtn.getAttribute('data-copy-text') || '';
                  navigator.clipboard.writeText(text).then(function() {
                    copyBtn.textContent = '✓';
                    setTimeout(function() { copyBtn.innerHTML = '&#128203;'; }, 1500);
                  });
                });
                cmdBox.appendChild(copyBtn);
                card.appendChild(cmdBox);

                var isUrl = /^https?:[/][/]/.test(method.command || '');
                var termBtn = document.createElement('button');
                termBtn.className = 'install-method-terminal-btn';
                termBtn.innerHTML = isUrl ? '&#127760; Open in Browser' : '&#9654; Run in Terminal';
                termBtn.setAttribute('data-command', method.command || '');
                termBtn.addEventListener('click', function() {
                  var cmd = termBtn.getAttribute('data-command') || '';
                  postMessageWithPanelId({
                    type: 'openTerminal',
                    payload: {
                      providerId: currentInstallProviderId,
                      command: cmd
                    }
                  });
                });
                card.appendChild(termBtn);

                methodsList.appendChild(card);
              });
            }
          }
        }

        modal.classList.remove('hidden');
      }

      function hideInstallProviderModal() {
        var modal = document.getElementById('install-provider-modal');
        if (modal) {
          modal.classList.add('hidden');
        }
        currentInstallProviderId = null;
      }

      function startAutoInstallFromModal() {
        if (!currentInstallProviderId) return;

        // Show progress, hide auto-install section
        var autoSection = document.getElementById('install-auto-section');
        var progressSection = document.getElementById('install-progress-section');
        if (autoSection) autoSection.classList.add('hidden');
        if (progressSection) progressSection.classList.remove('hidden');

        postMessageWithPanelId({
          type: 'startProviderSetup',
          payload: { providerId: currentInstallProviderId, autoInstall: true }
        });
      }

      function updateInstallProgress(payload) {
        var progressFill = document.getElementById('install-progress-fill');
        var progressMsg = document.getElementById('install-progress-msg');

        if (progressFill) {
          progressFill.style.width = payload.progress + '%';
        }
        if (progressMsg) {
          progressMsg.textContent = payload.message;
        }

        if (payload.step === 'complete') {
          if (progressMsg) progressMsg.textContent = '✓ ' + payload.message;
          // Hide error details on success
          var errorDetails = document.getElementById('install-error-details');
          if (errorDetails) {
            errorDetails.classList.add('hidden');
            errorDetails.innerHTML = '';
          }
          setTimeout(function() {
            hideInstallProviderModal();
            // Refresh availability
            postMessageWithPanelId({ type: 'requestProviderAvailability' });
          }, 1500);
        } else if (payload.step === 'failed') {
          if (progressMsg) progressMsg.textContent = '✗ ' + payload.message;

          // Show enhanced error details in the install modal
          var installErrorDetails = document.getElementById('install-error-details');
          if (installErrorDetails) {
            var category = payload.errorCategory || 'unknown';
            var categoryLabels = {
              'permission': 'Permission', 'network': 'Network', 'version': 'Version',
              'not-found': 'Not Found', 'command-failed': 'Command Failed',
              'timeout': 'Timeout', 'unknown': 'Error'
            };

            var errorHtml = '<div class="error-detail-header">' +
              '<span class="error-category-badge ' + category + '">' + (categoryLabels[category] || 'Error') + '</span>' +
              '</div>' +
              '<div class="error-message-text">' + escapeHtml(payload.message) + '</div>';

            if (payload.suggestedFix) {
              errorHtml += '<div class="error-suggested-fix">' +
                '<div class="error-suggested-fix-label">Suggested Fix</div>' +
                '<div>' + escapeHtml(payload.suggestedFix) + '</div>' +
                '</div>';
            }

            if (payload.alternativeCommands && payload.alternativeCommands.length > 0) {
              errorHtml += '<div class="error-alt-commands"><div class="error-alt-commands-label">Alternative Install Methods</div>';
              payload.alternativeCommands.forEach(function(item) {
                var cmdText = typeof item === 'string' ? item : item.command;
                var cmdLabel = typeof item === 'string' ? '' : item.label;
                errorHtml += '<div class="error-alt-command-row">' +
                  (cmdLabel ? '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-right:4px;">' + escapeHtml(cmdLabel) + ':</span>' : '') +
                  '<code>' + escapeHtml(cmdText) + '</code>' +
                  '<button class="error-alt-command-copy" data-copy-text="' + escapeHtml(cmdText) + '" title="Copy">&#128203;</button></div>';
              });
              errorHtml += '</div>';
            }

            installErrorDetails.innerHTML = errorHtml;
            installErrorDetails.classList.remove('hidden');

            // Attach copy handlers via data attributes
            installErrorDetails.querySelectorAll('.error-alt-command-copy[data-copy-text]').forEach(function(btn) {
              btn.addEventListener('click', function() {
                copyToClipboard(btn.getAttribute('data-copy-text') || '');
              });
            });
          }

          // Show auto-install section again after delay (if retryable)
          if (payload.retryable !== false) {
            setTimeout(function() {
              var autoSection = document.getElementById('install-auto-section');
              if (autoSection) autoSection.classList.remove('hidden');
            }, 2000);
          }
        }
      }

      // W5: install-modal icons come from the manifest (covers every
      // registered provider, theme-aware where declared).
      function getProviderIconUri(providerId) {
        return getAgentLogo(providerId);
      }

      // Setup install modal event listeners
      (function setupInstallModalListeners() {
        var autoBtn = document.getElementById('install-auto-btn');
        if (autoBtn) {
          autoBtn.addEventListener('click', startAutoInstallFromModal);
        }

        var copyBtn = document.getElementById('install-copy-btn');
        if (copyBtn) {
          copyBtn.addEventListener('click', function() {
            var commandText = document.getElementById('install-command-text');
            if (commandText) {
              navigator.clipboard.writeText(commandText.textContent).then(function() {
                copyBtn.textContent = '✓';
                setTimeout(function() { copyBtn.innerHTML = '&#128203;'; }, 1500);
              });
            }
          });
        }

        var terminalBtn = document.getElementById('install-terminal-btn');
        if (terminalBtn) {
          terminalBtn.addEventListener('click', function() {
            var commandText = document.getElementById('install-command-text');
            if (commandText && currentInstallProviderId) {
              postMessageWithPanelId({
                type: 'openTerminal',
                payload: {
                  providerId: currentInstallProviderId,
                  command: commandText.textContent || ''
                }
              });
            }
          });
        }

        var refreshBtn = document.getElementById('install-refresh-btn');
        if (refreshBtn) {
          refreshBtn.addEventListener('click', function() {
            postMessageWithPanelId({
              type: 'refreshProviderDetection',
              payload: {}
            });
            refreshBtn.textContent = '⟳ Refreshing...';
            setTimeout(function() { refreshBtn.innerHTML = '&#8635; Refresh Detection'; }, 2000);
          });
        }

        var closeBtn = document.getElementById('install-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', hideInstallProviderModal);
        }

        // Close modal when clicking outside
        var modal = document.getElementById('install-provider-modal');
        if (modal) {
          modal.addEventListener('click', function(e) {
            if (e.target === modal) {
              hideInstallProviderModal();
            }
          });
        }
      })();

      function hideWizard() {
        var wizard = document.getElementById('setup-wizard');
        if (wizard) {
          wizard.classList.add('hidden');
        }
        state.wizard.visible = false;
      }

      // ========================================
      // Brainstorm Mode Handlers (Redesigned)
      // ========================================

      var brainstormAgentTimeouts = {};
      // Per-agent thinking state lives on each agent body's .thinking-zone
      // element (Plan 02 Phase 3.4) — no agent-keyed buffers here.

      function buildProgressStepper(hasDiscussion, strategy) {
        var steps = [{ phase: 'individual', label: 'Individual' }];
        if (hasDiscussion) {
          steps.push({ phase: 'discussion', label: 'Discussion' });
        }
        steps.push({ phase: 'synthesis', label: 'Synthesis' });
        steps.push({ phase: 'complete', label: 'Complete' });

        var strategyNames = {
          'quick': 'Quick', 'debate': 'Debate', 'red-team': 'Red Team',
          'perspectives': 'Perspectives', 'delphi': 'Delphi'
        };

        var html = '<div class="brainstorm-progress-stepper" id="brainstorm-stepper">';
        steps.forEach(function(step, i) {
          var cls = i === 0 ? ' active' : '';
          html += '<div class="brainstorm-step' + cls + '" data-phase="' + step.phase + '">' +
            '<span class="brainstorm-step-number">' + (i + 1) + '</span>' +
            '<span>' + step.label + '</span></div>';
          if (i < steps.length - 1) {
            html += '<div class="brainstorm-step-connector" data-after="' + step.phase + '"></div>';
          }
        });
        if (strategy) {
          html += '<span class="brainstorm-stepper-strategy" id="brainstorm-strategy-label-stepper">' + (strategyNames[strategy] || strategy) + '</span>';
        }
        html += '</div>';
        return html;
      }

      function updateProgressStepper(currentPhase) {
        var stepper = document.getElementById('brainstorm-stepper');
        if (!stepper) return;

        var allSteps = stepper.querySelectorAll('.brainstorm-step');
        var allConns = stepper.querySelectorAll('.brainstorm-step-connector');
        var phases = [];
        allSteps.forEach(function(s) { phases.push(s.dataset.phase); });
        var currentIdx = phases.indexOf(currentPhase);

        allSteps.forEach(function(step, i) {
          step.classList.remove('active', 'completed');
          if (i < currentIdx) {
            step.classList.add('completed');
          } else if (i === currentIdx) {
            step.classList.add('active');
          }
        });

        allConns.forEach(function(conn) {
          var afterPhase = conn.dataset.after;
          var afterIdx = phases.indexOf(afterPhase);
          if (afterIdx < currentIdx) {
            conn.classList.add('completed');
          } else {
            conn.classList.remove('completed');
          }
        });
      }

      function createSynthesisMessage() {
        var synthEl = document.createElement('div');
        synthEl.className = 'message assistant streaming';
        synthEl.dataset.brainstormSynthesis = 'true';
        synthEl.innerHTML =
          '<div class="message-header"><div class="message-role-container">' +
          '<span class="message-role assistant">Mysti</span>' +
          '<span class="message-model-info">Brainstorm Synthesis</span>' +
          '</div></div>' +
          '<div class="message-body"><div class="message-content"></div></div>';
        messagesEl.appendChild(synthEl);
        scrollToBottom();
      }

      function makeCollapsible(sectionId, label) {
        var section = document.getElementById(sectionId);
        if (!section || section.previousElementSibling && section.previousElementSibling.classList.contains('brainstorm-section-toggle')) return;

        var toggle = document.createElement('div');
        toggle.className = 'brainstorm-section-toggle';
        toggle.innerHTML = '<span class="toggle-chevron">&#9660;</span> ' + escapeHtml(label);
        toggle.addEventListener('click', function() {
          toggle.classList.toggle('collapsed');
          section.classList.toggle('collapsed');
        });

        section.parentNode.insertBefore(toggle, section);

        // Auto-collapse after a short delay
        setTimeout(function() {
          toggle.classList.add('collapsed');
          section.classList.add('collapsed');
        }, 500);
      }

      function startAgentTimeouts(agents) {
        agents.forEach(function(agentId) {
          brainstormAgentTimeouts[agentId] = setTimeout(function() {
            var typingEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-typing');
            if (typingEl) {
              typingEl.innerHTML = '<span class="brainstorm-agent-timeout">&#9888;&#65039; Taking longer than expected...</span>';
            }
          }, 30000);
        });
      }

      function clearAgentTimeout(agentId) {
        if (brainstormAgentTimeouts[agentId]) {
          clearTimeout(brainstormAgentTimeouts[agentId]);
          delete brainstormAgentTimeouts[agentId];
        }
      }

      function handleBrainstormStarted(payload) {
        var sessionId = payload.sessionId || Date.now().toString();
        state.brainstormSession = sessionId;
        state.brainstormPhase = 'individual';
        state.brainstormStrategy = payload.strategy || null;
        state.agentResponses = {};
        state.discussionContent = {};
        state.currentDiscussionRound = 0;

        // Set loading state for buttons only (no loading dots)
        state.isLoading = true;
        if (sendBtn) { sendBtn.style.display = 'none'; }
        if (stopBtn) { stopBtn.style.display = 'flex'; }

        // Hide quick actions while brainstorm runs
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) {
          quickActionsContainer.classList.add('ai-running');
        }

        var agents = state.brainstormAgents || defaultBrainstormPair();
        var strategy = payload.strategy || state.brainstormStrategy || 'quick';
        var hasDiscussion = strategy !== 'quick';

        // Build progress stepper
        var stepperHtml = buildProgressStepper(hasDiscussion, strategy);

        // Build agent message blocks (full-width, chat-style)
        var agentMessagesHtml = agents.map(function(agentId) {
          var agentInfo = getAgentDisplay(agentId);
          var logoSrc = agentInfo.logo;

          return '<div class="brainstorm-agent-message" data-agent="' + agentId + '" style="--agent-color: ' + agentInfo.color + ';">' +
            '<div class="brainstorm-agent-message-header">' +
              '<div class="brainstorm-agent-role-container">' +
                '<span class="brainstorm-agent-role">' +
                  '<img src="' + logoSrc + '" alt="' + agentInfo.name + '" class="brainstorm-agent-role-logo" data-agent-logo="' + agentId + '" />' +
                  '<span style="color: ' + agentInfo.color + ';">' + agentInfo.name + '</span>' +
                '</span>' +
              '</div>' +
            '</div>' +
            '<div class="brainstorm-agent-message-body" id="brainstorm-' + agentInfo.shortId + '-body">' +
              '<div class="brainstorm-agent-typing" id="brainstorm-' + agentInfo.shortId + '-typing">' +
                '<div class="brainstorm-agent-typing-dots">' +
                  '<div class="dot"></div><div class="dot"></div><div class="dot"></div>' +
                '</div>' +
                '<span>Analyzing...</span>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Create container
        var container = document.createElement('div');
        container.className = 'brainstorm-container';
        container.id = 'brainstorm-' + sessionId;
        container.innerHTML = stepperHtml +
          '<div class="brainstorm-agents-section" id="brainstorm-agents-section-' + sessionId + '">' +
            agentMessagesHtml +
          '</div>' +
          '<div class="brainstorm-discussion-wrapper hidden" id="brainstorm-discussion-wrapper-' + sessionId + '">' +
            '<div class="brainstorm-discussion-bubbles" id="brainstorm-discussion-bubbles-' + sessionId + '"></div>' +
          '</div>';

        messagesEl.appendChild(container);
        scrollToBottom();

        // Start timeout warnings
        startAgentTimeouts(agents);
      }

      function handleBrainstormAgentChunk(payload) {
        var agentId = payload.agentId;
        var content = payload.content || '';
        var chunkType = payload.type || 'text';

        var bodyEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-body');
        if (!bodyEl) return;

        // Remove typing indicator on first chunk
        var typingEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-typing');
        if (typingEl) typingEl.remove();

        // Clear timeout for this agent
        clearAgentTimeout(agentId);

        if (chunkType === 'thinking') {
          // Plan 02 Phase 3.4: brainstorm bubbles render the SAME unified
          // thinking zone as main chat — the per-agent body element keeps
          // the per-agent buffer state, so no agent-keyed maps needed.
          renderThinkingZone(bodyEl, getThinkingStyle(agentId), content);
        } else {
          // Accumulate text content
          if (!state.agentResponses[agentId]) {
            state.agentResponses[agentId] = '';
          }
          state.agentResponses[agentId] += content;

          var textContainer = bodyEl.querySelector('.brainstorm-text-content');
          if (!textContainer) {
            textContainer = document.createElement('div');
            textContainer.className = 'brainstorm-text-content';
            bodyEl.appendChild(textContainer);
          }
          textContainer.innerHTML = formatContent(state.agentResponses[agentId]);
        }
        scrollToBottom();
      }

      function handleBrainstormAgentComplete(payload) {
        var agentId = payload.agentId;

        // Clear any remaining timeout (per-agent thinking state lives on the
        // agent body's .thinking-zone element — nothing to reset here)
        clearAgentTimeout(agentId);
      }

      function handleBrainstormPhaseChange(payload) {
        state.brainstormPhase = payload.phase;

        if (payload.strategy) {
          state.brainstormStrategy = payload.strategy;
          var strategyLabel = document.getElementById('brainstorm-strategy-label-stepper');
          if (strategyLabel) {
            var strategyNames = {
              'quick': 'Quick', 'debate': 'Debate', 'red-team': 'Red Team',
              'perspectives': 'Perspectives', 'delphi': 'Delphi'
            };
            strategyLabel.textContent = strategyNames[payload.strategy] || payload.strategy;
          }
        }

        updateProgressStepper(payload.phase);

        if (payload.phase === 'discussion') {
          var wrapper = document.getElementById('brainstorm-discussion-wrapper-' + state.brainstormSession);
          if (wrapper) wrapper.classList.remove('hidden');
        }

        if (payload.phase === 'synthesis') {
          createSynthesisMessage();
        }
      }

      function handleBrainstormSynthesisChunk(payload) {
        var content = payload.content || '';

        if (!state.synthesisContent) {
          state.synthesisContent = '';
        }
        state.synthesisContent += content;

        var synthMsgContent = document.querySelector(
          '.message.assistant[data-brainstorm-synthesis="true"] .message-content'
        );
        if (synthMsgContent) {
          synthMsgContent.innerHTML = formatContent(state.synthesisContent);
        }
        scrollToBottom();
      }

      function handleBrainstormDiscussionRoundStart(payload) {
        var wrapper = document.getElementById('brainstorm-discussion-wrapper-' + state.brainstormSession);
        if (wrapper) wrapper.classList.remove('hidden');

        var bubblesContainer = document.getElementById('brainstorm-discussion-bubbles-' + state.brainstormSession);
        if (!bubblesContainer) return;

        var roundLabel = payload.label || ('Round ' + payload.roundNumber);
        var marker = document.createElement('div');
        marker.className = 'discussion-round-divider';
        marker.textContent = roundLabel;
        bubblesContainer.appendChild(marker);
        scrollToBottom();
      }

      function handleBrainstormDiscussionChunk(payload) {
        var agentId = payload.agentId;
        var content = payload.content || '';
        var role = payload.role || '';

        var bubblesContainer = document.getElementById('brainstorm-discussion-bubbles-' + state.brainstormSession);
        if (!bubblesContainer) return;

        // Show discussion wrapper
        var wrapper = document.getElementById('brainstorm-discussion-wrapper-' + state.brainstormSession);
        if (wrapper) wrapper.classList.remove('hidden');

        // Determine alignment: first agent = left, second = right
        var agents = state.brainstormAgents || [];
        var isLeftAgent = agents.indexOf(agentId) === 0;
        var alignment = isLeftAgent ? 'agent-left' : 'agent-right';

        var msgId = 'discussion-msg-' + agentId + '-' + (state.currentDiscussionRound || 1);
        var msgEl = document.getElementById(msgId);

        if (!msgEl) {
          var agentInfo = getAgentDisplay(agentId);
          var logoSrc = agentInfo.logo;

          msgEl = document.createElement('div');
          msgEl.className = 'discussion-bubble ' + alignment;
          msgEl.id = msgId;
          msgEl.style.setProperty('--agent-color', agentInfo.color);
          msgEl.innerHTML =
            '<div class="discussion-bubble-header">' +
              '<img src="' + logoSrc + '" alt="' + agentInfo.name + '" class="discussion-bubble-logo" data-agent-logo="' + agentId + '" />' +
              '<span class="discussion-bubble-name">' + agentInfo.name + '</span>' +
              (role ? '<span class="discussion-bubble-role ' + role + '">' + role.replace('-', ' ') + '</span>' : '') +
            '</div>' +
            '<div class="discussion-bubble-content"></div>';
          bubblesContainer.appendChild(msgEl);
        }

        // Accumulate content
        var stateKey = 'discussion_' + agentId + '_' + (state.currentDiscussionRound || 1);
        if (!state.discussionContent) state.discussionContent = {};
        if (!state.discussionContent[stateKey]) state.discussionContent[stateKey] = '';
        state.discussionContent[stateKey] += content;

        var contentEl = msgEl.querySelector('.discussion-bubble-content');
        if (contentEl) {
          contentEl.innerHTML = formatContent(state.discussionContent[stateKey]);
        }
        scrollToBottom();
      }

      function handleBrainstormConvergenceUpdate(payload) {
        var convergence = payload.convergence;
        if (!convergence) return;

        var bubblesContainer = document.getElementById('brainstorm-discussion-bubbles-' + state.brainstormSession);
        if (!bubblesContainer) return;

        // Remove existing convergence meter if any
        var existing = bubblesContainer.querySelector('.convergence-meter');
        if (existing) existing.remove();

        var pct = Math.round(convergence.overallConvergence * 100);
        var level = pct < 30 ? 'low' : (pct < 70 ? 'medium' : 'high');

        var meter = document.createElement('div');
        meter.className = 'convergence-meter';
        meter.innerHTML =
          '<span class="convergence-label">Convergence</span>' +
          '<div class="convergence-bar-container">' +
            '<div class="convergence-bar ' + level + '" style="width: ' + pct + '%"></div>' +
          '</div>' +
          '<span class="convergence-label">' + pct + '%</span>' +
          '<span class="convergence-status ' + convergence.recommendation + '">' + convergence.recommendation + '</span>';
        bubblesContainer.appendChild(meter);
        scrollToBottom();
      }

      function handleBrainstormDiscussionError(payload) {
        var bubblesContainer = document.getElementById('brainstorm-discussion-bubbles-' + state.brainstormSession);
        if (!bubblesContainer) return;

        var agentInfo = getAgentDisplay(payload.agentId);
        var errorEl = document.createElement('div');
        errorEl.className = 'brainstorm-error';
        errorEl.innerHTML = '<span class="error-icon">&#9888;&#65039;</span> ' + escapeHtml(agentInfo.name) + ' encountered an error: ' + escapeHtml(payload.error || 'Unknown error');
        bubblesContainer.appendChild(errorEl);
      }

      function handleBrainstormAgentErrorEvent(payload) {
        var agentId = payload.agentId;
        var error = payload.error || 'Agent encountered an error';

        // Clear timeout
        clearAgentTimeout(agentId);

        // Remove typing indicator
        var typingEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-typing');
        if (typingEl) typingEl.remove();

        // Show error in the agent's message body
        var bodyEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-body');
        if (bodyEl) {
          var errorEl = document.createElement('div');
          errorEl.className = 'brainstorm-error';
          errorEl.innerHTML = '<span class="error-icon">&#9888;&#65039;</span> ' + escapeHtml(error);
          bodyEl.appendChild(errorEl);
        }
      }

      function handleBrainstormComplete(payload) {
        state.brainstormPhase = 'complete';
        state.isLoading = false;

        // Reset buttons
        if (sendBtn) {
          sendBtn.style.display = 'flex';
          sendBtn.disabled = false;
        }
        if (stopBtn) {
          stopBtn.style.display = 'none';
        }

        // Show quick actions again
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) {
          quickActionsContainer.classList.remove('ai-running');
        }

        updateProgressStepper('complete');

        // Finalize synthesis message
        var synthMsg = document.querySelector('.message.assistant[data-brainstorm-synthesis="true"]');
        if (synthMsg) {
          synthMsg.classList.remove('streaming');
          if (payload.message) {
            synthMsg.dataset.id = payload.message.id;
          }
        } else if (payload.unifiedSolution) {
          // Fallback: create synthesis message from payload if streaming didn't create one
          var div = document.createElement('div');
          div.className = 'message assistant';
          div.innerHTML = '<div class="message-header"><div class="message-role-container">' +
            '<span class="message-role assistant">Mysti</span>' +
            '<span class="message-model-info">Brainstorm Synthesis</span>' +
            '</div></div><div class="message-body"><div class="message-content">' +
            formatContent(payload.unifiedSolution) + '</div></div>';
          if (payload.message) div.dataset.id = payload.message.id;
          messagesEl.appendChild(div);
        }

        // Make individual analysis and discussion sections collapsible
        var sessionId = state.brainstormSession;
        makeCollapsible('brainstorm-agents-section-' + sessionId, 'Individual Analysis');
        makeCollapsible('brainstorm-discussion-wrapper-' + sessionId, 'Team Discussion');

        // Clear state
        state.synthesisContent = '';
        state.discussionContent = {};
        state.currentDiscussionRound = 0;

        // Clear all agent timeouts
        Object.keys(brainstormAgentTimeouts).forEach(function(id) {
          clearTimeout(brainstormAgentTimeouts[id]);
        });
        brainstormAgentTimeouts = {};

        scrollToBottom();
      }

      function handleBrainstormError(payload) {
        state.isLoading = false;

        // Reset buttons
        if (sendBtn) {
          sendBtn.style.display = 'flex';
          sendBtn.disabled = false;
        }
        if (stopBtn) {
          stopBtn.style.display = 'none';
        }

        // Show quick actions again
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) {
          quickActionsContainer.classList.remove('ai-running');
        }

        var errorMsg = payload.error || 'Brainstorm session failed';

        var container = document.getElementById('brainstorm-' + state.brainstormSession);
        if (container) {
          var errorEl = document.createElement('div');
          errorEl.className = 'brainstorm-error';
          errorEl.innerHTML = '<span class="error-icon">&#9888;&#65039;</span> ' + escapeHtml(errorMsg);
          container.appendChild(errorEl);
        } else {
          showError(errorMsg);
        }

        // Clear all agent timeouts
        Object.keys(brainstormAgentTimeouts).forEach(function(id) {
          clearTimeout(brainstormAgentTimeouts[id]);
        });
        brainstormAgentTimeouts = {};
      }

      function handleLifecycleEvent(payload) {
        if (!payload) { return; }
        var type = payload.type;
        if (type === 'session-idle') {
          sessionIndicator.className = 'session-indicator idle';
          sessionIndicator.querySelector('.session-dot').nextSibling.textContent = ' Idle';
        } else if (type === 'shutdown-blocked') {
          sessionIndicator.className = 'session-indicator blocked';
          var childCount = (payload.childPids && payload.childPids.length) || 0;
          sessionIndicator.querySelector('.session-dot').nextSibling.textContent =
            ' Active (' + childCount + ' process' + (childCount !== 1 ? 'es' : '') + ')';
          addSystemMessage('Agent shutdown blocked: ' + (payload.detail || 'active child processes'));
        } else if (type === 'session-expired' || type === 'session-shutdown') {
          sessionIndicator.style.display = 'none';
          sessionIndicator.className = 'session-indicator';
        } else if (type === 'session-started') {
          sessionIndicator.style.display = 'flex';
          sessionIndicator.className = 'session-indicator';
        } else if (type === 'children-detected') {
          sessionIndicator.className = 'session-indicator blocked';
        } else if (type === 'children-cleared') {
          if (sessionIndicator.classList.contains('blocked')) {
            sessionIndicator.className = 'session-indicator idle';
          }
        }
      }

      function handleFileLineNumber(payload) {
        // Find edit report card with this file path and update line numbers
        var cards = document.querySelectorAll('.edit-report-card[data-file-path="' + payload.filePath + '"]');
        cards.forEach(function(card) {
          var baseLineNum = payload.lineNumber;
          // Store line number on card for Open File button to use
          card.dataset.lineNumber = String(baseLineNum);
          // Update diff line numbers display
          var lineNumEls = card.querySelectorAll('.edit-report-diff-linenum');
          lineNumEls.forEach(function(el, idx) {
            el.textContent = String(baseLineNum + idx);
          });
        });
      }

      function handleFileReverted(payload) {
        // Find all file edit cards with this path and update the revert button (legacy cards)
        var cards = document.querySelectorAll('.file-edit-card[data-file-path="' + payload.path + '"]');
        cards.forEach(function(card) {
          var revertBtn = card.querySelector('.file-edit-revert');
          if (revertBtn) {
            if (payload.success) {
              revertBtn.textContent = 'Reverted';
              revertBtn.disabled = true;
              revertBtn.style.color = 'var(--vscode-charts-green)';
            } else {
              revertBtn.textContent = 'Failed';
              revertBtn.disabled = false;
              revertBtn.style.color = 'var(--vscode-charts-red)';
              setTimeout(function() {
                revertBtn.textContent = 'Revert';
                revertBtn.style.color = '';
              }, 2000);
            }
          }
        });

        // Find all edit report cards with this path and update the revert button
        var editReportCards = document.querySelectorAll('.edit-report-card[data-file-path="' + payload.path + '"]');
        editReportCards.forEach(function(card) {
          var revertBtn = card.querySelector('.edit-report-btn-revert');
          if (revertBtn) {
            if (payload.success) {
              revertBtn.textContent = 'Reverted';
              revertBtn.disabled = true;
              revertBtn.classList.add('reverted');
            } else {
              revertBtn.textContent = 'Failed';
              revertBtn.classList.add('failed');
              setTimeout(function() {
                revertBtn.textContent = 'Revert';
                revertBtn.disabled = false;
                revertBtn.classList.remove('failed');
              }, 2000);
            }
          }
        });
      }

      function initializeState(payload) {
        dismissInitLoading();
        // Perf: the mysti.debug.performanceLogging flag rides the
        // initialState payload (starts/stops heap sampling + chunk timing).
        perfSetEnabled(!!payload.performanceLogging);
        var savedAgentSettings = state.agentSettings;
        state = Object.assign({}, state, payload);
        if (payload.agentSettings) {
          state.agentSettings = Object.assign({}, savedAgentSettings, payload.agentSettings);
        }

        // Plan 02 Phase 2: only trust a manifest whose schema matches the
        // one this webview build was generated against.
        if (state.providerManifest && state.providerManifest.schemaVersion !== EXPECTED_MANIFEST_SCHEMA_VERSION) {
          console.warn('[Mysti Webview] Ignoring provider manifest with unexpected schemaVersion:', state.providerManifest.schemaVersion);
          state.providerManifest = null;
        }
        // Build every manifest-derived surface (provider dropdown, brainstorm
        // options, mention short-id map) before values are applied below.
        applyProviderManifest();

        modeSelect.value = state.settings.mode;
        thinkingSelect.value = state.settings.thinkingLevel;
        accessSelect.value = state.settings.accessLevel;
        if (contextModeLabel) {
          contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
        }
        updateBehaviorIndicator();
        updateBehaviorHint();

        // Set agent based on provider setting
        // Brainstorm is an agent type, not a mode - user selects it from the agent dropdown
        if (state.settings.provider) {
          providerSelect.value = state.settings.provider;
          state.activeAgent = state.settings.provider;
          // W1: thinking selector visibility is capability-driven
          updateThinkingSectionVisibility(state.settings.provider);
          // Show strategy chip if brainstorm is active
          updateStrategyIndicatorVisibility(state.settings.provider);
        }

        // Populate model dropdown based on selected provider
        if (state.providers && state.providers.length > 0) {
          var provider = state.providers.find(function(p) { return p.name === state.settings.provider; });
          if (provider) {
            modelSelect.innerHTML = provider.models.map(function(m) {
              return '<option value="' + m.id + '"' + (m.id === state.settings.model ? ' selected' : '') + '>' + m.name + '</option>';
            }).join('');
            // Append "Custom..." option
            modelSelect.innerHTML += '<option value="__custom__">Custom...</option>';
          }
        }

        // Restore custom model if set in provider settings
        if (state.providerSettings && state.providerSettings.customModel) {
          modelSelect.value = '__custom__';
          customModelSection.classList.remove('hidden');
          customModelInput.value = state.providerSettings.customModel;
        }

        // W4: render the selected provider's declarative settings sections
        // (values restored from state.providerSettings by settingKey)
        renderProviderSettingsSections(state.settings.provider);

        // Update agent menu to match settings
        updateAgentMenuSelection();
        updateThemeAwareLogos();

        // Update provider availability (disable unavailable providers)
        updateProviderAvailability();

        updateContext(state.context);

        // Initialize agent configuration
        if (state.availablePersonas && state.availableSkills) {
          // Set agentConfig from conversation or use default
          if (state.agentConfig) {
            state.agentConfig = state.agentConfig;
          } else {
            state.agentConfig = { personaId: null, enabledSkills: [] };
          }
          renderAgentConfigPanel();
        }

        // Initialize agent settings UI
        if (state.agentSettings) {
          updateAgentSettingsUI();
        }

        // Initialize brainstorm agents UI
        if (state.brainstormAgents) {
          updateBrainstormAgentsUI();
        }
        // Initialize brainstorm strategy dropdown
        if (state.brainstormStrategy && brainstormStrategySelect) {
          brainstormStrategySelect.value = state.brainstormStrategy;
          if (brainstormStrategyHint) {
            brainstormStrategyHint.textContent = strategyDescriptions[state.brainstormStrategy] || '';
          }
        }
        updateBrainstormSectionVisibility();

        // Initialize autonomous sub-settings (timeout behavior, safety, etc.)
        if (state.permissionSettings) {
          var tbSelect = document.getElementById('timeout-behavior-select');
          if (tbSelect) {
            // If semi-autonomous was set (meaning autonomous is active), show as auto-reject in the dropdown
            var tbValue = state.permissionSettings.timeoutBehavior;
            tbSelect.value = (tbValue === 'semi-autonomous') ? 'auto-reject' : (tbValue || 'auto-reject');
          }
          var saTimeoutInput = document.getElementById('semi-auto-timeout-input');
          if (saTimeoutInput) {
            saTimeoutInput.value = state.permissionSettings.semiAutonomousTimeout || 60;
          }
          // Autonomy sub-settings visibility depends on current autonomy level
          showAutonomySubSettings(state.autonomyLevel);
          updateAutonomyIndicator();

          // Send authoritative autonomy level to backend (prevents stale config issues)
          postMessageWithPanelId({
            type: 'autonomyLevelChanged',
            payload: { level: state.autonomyLevel }
          });
        }

        // Initialize sticky progress observer for scroll-aware sticking
        initStickyProgressObserver();

        if (state.conversation && state.conversation.messages) {
          state.conversation.messages.forEach(function(msg) { addMessage(msg); });
        }

        // Preload workspace files for @-mention autocomplete
        postMessageWithPanelId({ type: 'getWorkspaceFiles' });

        // Initialize GitHub star count badge
        if (state.githubStarCount && state.githubStarCount > 0) {
          var starBadge = document.getElementById('github-star-badge');
          var starCountEl = document.getElementById('github-star-count');
          if (starBadge && starCountEl) {
            starCountEl.textContent = state.githubStarCount >= 1000
              ? (state.githubStarCount / 1000).toFixed(1) + 'K'
              : String(state.githubStarCount);
            starBadge.style.display = 'inline-flex';
          }
        }

        // Usage stats
        if (state.usageStats) {
          var stats = state.usageStats;
          var convEl = document.getElementById('stat-conversations');
          var msgEl = document.getElementById('stat-messages');
          var brainEl = document.getElementById('stat-brainstorms');
          var streakEl = document.getElementById('stat-streak');
          if (convEl) convEl.textContent = String(stats.totalConversations || 0);
          if (msgEl) msgEl.textContent = String(stats.totalMessages || 0);
          if (brainEl) brainEl.textContent = String(stats.totalBrainstorms || 0);
          if (streakEl) streakEl.textContent = String(stats.dayStreak || 0);
        }

        // Badges
        if (state.badges && state.badgeCounts) {
          updateBadgesUI(state.badges, state.badgeCounts);
        }

        // Share on X button handler
        var shareBtn = document.getElementById('share-on-x');
        if (shareBtn) {
          shareBtn.addEventListener('click', function(e) {
            e.preventDefault();
            var tweetText = encodeURIComponent("I've been Mysting — 8 AI agents brainstorm together in VS Code. Claude, Gemini, and Copilot debate & synthesize solutions. Try it: https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti #Mysting");
            var tweetUrl = 'https://twitter.com/intent/tweet?text=' + tweetText;
            postMessageWithPanelId({ type: 'openExternal', payload: { url: tweetUrl } });
          });
        }

        // Perf: signal time-to-usable after the initial render has painted.
        // Posted UNCONDITIONALLY (panel.timeToUsable is a coarse always-on
        // measure), once per webview lifetime.
        perfPostUiReady();
      }

      // ============================================================================
      // Attachment helpers (paste/drop image & file support)
      // ============================================================================

      var IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
      var MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
      var MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
      var MAX_ATTACHMENTS = 10;

      function handleDroppedFiles(dataTransfer) {
        if (!dataTransfer || !dataTransfer.files || dataTransfer.files.length === 0) return;

        for (var i = 0; i < dataTransfer.files.length; i++) {
          var file = dataTransfer.files[i];
          var ext = (file.name.split('.').pop() || '').toLowerCase();
          var isImage = file.type.startsWith('image/') || IMAGE_EXTENSIONS.indexOf(ext) !== -1;
          var sizeLimit = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
          var sizeLimitLabel = isImage ? '5 MB' : '10 MB';

          if (file.size > sizeLimit) {
            showToast('"' + file.name + '" too large (max ' + sizeLimitLabel + ')', 'error');
            continue;
          }
          if (state.attachments.length >= MAX_ATTACHMENTS) {
            showToast('Maximum ' + MAX_ATTACHMENTS + ' attachments per message', 'error');
            break;
          }

          // Read file as base64 (both images and non-image files)
          (function(f, fIsImage, fExt) {
            var reader = new FileReader();
            reader.onload = function(evt) {
              var dataUrl = evt.target.result;
              var base64 = dataUrl.split(',')[1];
              var mimeType = f.type || (fIsImage ? 'image/' + fExt : 'application/octet-stream');
              state.attachments.push({
                id: 'att-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                type: fIsImage ? 'image' : 'file',
                fileName: f.name,
                mimeType: mimeType,
                base64Data: base64,
                size: f.size
              });
              renderAttachmentPreviews();
            };
            reader.onerror = function() {
              showToast('Failed to read: ' + f.name, 'error');
            };
            reader.readAsDataURL(f);
          })(file, isImage, ext);
        }
      }

      function renderAttachmentPreviews() {
        var container = document.getElementById('attachment-previews');
        if (!container) return;

        if (state.attachments.length === 0) {
          container.innerHTML = '';
          container.classList.remove('has-items');
          return;
        }

        container.classList.add('has-items');
        var html = '';
        for (var i = 0; i < state.attachments.length; i++) {
          var att = state.attachments[i];
          html += '<div class="attachment-preview-item" data-id="' + att.id + '">';
          if (att.type === 'image' && att.base64Data) {
            html += '<img src="data:' + att.mimeType + ';base64,' + att.base64Data + '" alt="' + att.fileName + '" title="' + att.fileName + '">';
          } else {
            html += '<div class="attachment-file-icon" title="' + att.fileName + '">&#128196;</div>';
          }
          html += '<span class="attachment-name">' + att.fileName + '</span>';
          html += '<button class="attachment-remove" data-id="' + att.id + '" title="Remove">&times;</button>';
          html += '</div>';
        }
        container.innerHTML = html;

        // Attach remove handlers
        var removeBtns = container.querySelectorAll('.attachment-remove');
        for (var j = 0; j < removeBtns.length; j++) {
          removeBtns[j].addEventListener('click', function(e) {
            e.stopPropagation();
            var removeId = this.getAttribute('data-id');
            state.attachments = state.attachments.filter(function(a) { return a.id !== removeId; });
            renderAttachmentPreviews();
          });
        }
      }

      function showToast(message, type) {
        var toast = document.createElement('div');
        toast.className = 'mysti-toast ' + (type || 'info');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:6px;font-size:12px;z-index:9999;background:var(--vscode-editorWidget-background);color:var(--vscode-editorWidget-foreground);border:1px solid var(--vscode-editorWidget-border);box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        if (type === 'error') {
          toast.style.borderColor = 'var(--vscode-errorForeground)';
        }
        document.body.appendChild(toast);
        setTimeout(function() {
          toast.style.opacity = '0';
          toast.style.transition = 'opacity 0.3s';
          setTimeout(function() { toast.remove(); }, 300);
        }, 3000);
      }

      function sendMessage() {
        var content = inputEl.value.trim();
        if (!content && state.attachments.length === 0) return;
        if (state.isLoading) return;

        // Hide quick actions when sending a message
        var quickActions = document.getElementById('quick-actions');
        if (quickActions) {
          quickActions.innerHTML = '';
        }

        if (content.startsWith('/')) {
          hideSlashMenu();
          var parts = content.slice(1).split(' ');
          var command = parts[0];
          var args = parts.slice(1).join(' ');
          // Send with both old and new format for backward compatibility
          postMessageWithPanelId({
            type: 'executeSlashCommand',
            payload: { command: command, args: args }
          });
          inputEl.value = '';
          inputEl.style.height = 'auto';
          return;
        }

        // Parse @-mentions from content
        var parsedMentions = parseMentionsFromContent(content);

        // Check if brainstorm mode is selected (use activeAgent which is set synchronously)
        if (state.activeAgent === 'brainstorm') {
          // In brainstorm mode, ignore agent mentions (brainstorm handles multi-agent)
          // but still pass file mentions
          var fileMentions = parsedMentions.filter(function(m) { return m.type === 'file'; });
          postMessageWithPanelId({
            type: 'sendBrainstormMessage',
            payload: {
              content: content,
              context: state.context,
              settings: state.settings,
              mentions: fileMentions.length > 0 ? fileMentions : undefined,
              attachments: state.attachments.length > 0 ? state.attachments : undefined
            }
          });
        } else {
          postMessageWithPanelId({
            type: 'sendMessage',
            payload: {
              content: content,
              context: state.context,
              settings: state.settings,
              mentions: parsedMentions.length > 0 ? parsedMentions : undefined,
              attachments: state.attachments.length > 0 ? state.attachments : undefined
            }
          });
        }

        inputEl.value = '';
        inputEl.style.height = 'auto';
        // Clear attachments after sending
        state.attachments = [];
        renderAttachmentPreviews();
        // Show Stop + lock the input immediately — don't wait for the backend's
        // responseStarted (which can be 100-500ms away). This is the fix for
        // "no stop button while the message is processing".
        setProcessing(true);
      }

      function addMessage(msg) {
        var welcome = messagesEl.querySelector('.welcome-container');
        if (welcome) welcome.remove();

        var div = document.createElement('div');
        div.className = 'message ' + msg.role;
        div.dataset.id = msg.id;

        var attribution = getMessageAttribution(msg);
        var roleLabel = msg.role === 'assistant' ? 'Mysti' : msg.role;
        var html = '<div class="message-header">';
        html += '<div class="message-role-container">';
        html += '<span class="message-role ' + msg.role + '">' + roleLabel + '</span>';
        if (msg.role === 'assistant') {
          // Per-message attribution (Plan 02 Phase 3.4): persisted
          // provider/model stamp, NOT the currently selected provider
          var attributionEntry = getManifestEntry(attribution.provider);
          var attributionTitle = attributionEntry ? 'Generated by ' + attributionEntry.displayName : '';
          html += '<span class="message-model-info" title="' + escapeHtml(attributionTitle) + '">' + getModelDisplayName(attribution.model) + '</span>';
        }
        html += '</div>';
        if (msg.role === 'assistant') {
          html += '<button class="message-copy-btn" data-message-id="' + msg.id + '" title="Copy message as Markdown">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>' +
            '</button>';
        }
        html += '</div>';

        // Render attachment thumbnails for user messages
        if (msg.attachments && msg.attachments.length > 0) {
          html += '<div class="message-attachments">';
          for (var ai = 0; ai < msg.attachments.length; ai++) {
            var att = msg.attachments[ai];
            if (att.type === 'image') {
              if (att.base64Data) {
                html += '<img class="message-attachment-img" src="data:' + att.mimeType + ';base64,' + att.base64Data + '" alt="' + escapeHtml(att.fileName) + '" title="' + escapeHtml(att.fileName) + '">';
              } else {
                html += '<span class="message-attachment-label">' + escapeHtml(att.fileName) + '</span>';
              }
            } else {
              html += '<span class="message-attachment-label">&#128196; ' + escapeHtml(att.fileName) + '</span>';
            }
          }
          html += '</div>';
        }

        div.innerHTML = html;

        if (msg.role === 'assistant') {
          // Plan 02 Phase 3.4: replay the restored message through the SAME
          // components used live — .message-body with interleaved thinking
          // zone / content segments / tool cards, then the unified footer.
          div.appendChild(buildRestoredMessageBody(msg));
          renderMessageFooter(div, null, attribution, []);
        } else {
          var contentEl = document.createElement('div');
          contentEl.className = 'message-content';
          contentEl.innerHTML = formatContent(msg.content);
          div.appendChild(contentEl);
        }

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // Build a restored assistant message's .message-body by replaying
      // persisted segments (exact stream order) — or, for legacy messages
      // without segments, the flat shape: one thinking block + body + tool
      // list. Same DOM as the live stream produces.
      function buildRestoredMessageBody(msg) {
        var body = document.createElement('div');
        body.className = 'message-body';

        var thinkingInfo = normalizeMessageThinking(msg.thinking);
        var thinkingStyle = thinkingInfo ? thinkingInfo.style : 'complete-blocks';

        var toolCallById = {};
        (msg.toolCalls || []).forEach(function(call) {
          if (call && call.id) toolCallById[call.id] = call;
        });

        if (msg.segments && msg.segments.length > 0) {
          var segmentIndex = 0;
          msg.segments.forEach(function(segment) {
            if (!segment) return;
            if (segment.type === 'thinking') {
              // All thinking funnels into ONE zone anchored where thinking
              // first appeared — identical to the live render.
              renderThinkingZone(body, thinkingStyle, segment.content || '');
            } else if (segment.type === 'text') {
              if (!segment.content) return;
              var segmentEl = document.createElement('div');
              segmentEl.className = 'message-content content-segment-' + segmentIndex;
              segmentIndex++;
              segmentEl.innerHTML = formatContent(segment.content);
              body.appendChild(segmentEl);
            } else if (segment.type === 'tool') {
              var call = toolCallById[segment.toolCallId];
              if (call) {
                body.appendChild(buildToolCallElement(call));
                delete toolCallById[segment.toolCallId];
              }
            }
          });
          // Defensive: tool calls not referenced by any segment still render
          (msg.toolCalls || []).forEach(function(call) {
            if (call && call.id && toolCallById[call.id]) {
              body.appendChild(buildToolCallElement(call));
            }
          });
        } else {
          // Legacy flat shape (no segments persisted)
          if (thinkingInfo) {
            renderThinkingZone(body, thinkingStyle, thinkingInfo.content);
          }
          if (msg.content) {
            var flatContent = document.createElement('div');
            flatContent.className = 'message-content';
            flatContent.innerHTML = formatContent(msg.content);
            body.appendChild(flatContent);
          }
          (msg.toolCalls || []).forEach(function(call) {
            if (call) body.appendChild(buildToolCallElement(call));
          });
        }

        return body;
      }

      function addSystemMessage(content) {
        var div = document.createElement('div');
        div.className = 'message system';
        div.innerHTML = '<div class="message-content">' + escapeHtml(content) + '</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      var currentResponse = '';
      var currentThinking = '';
      var contentSegmentIndex = 0;
      var pendingToolData = new Map(); // toolId -> { name, input } for edit report cards
      var currentTodos = []; // Track current todo list for sticky progress
      var previousTodoContents = new Set(); // Track previous todo content for completion detection
      var stuckTodoObservers = new Map(); // todoId -> IntersectionObserver
      var stuckTodos = new Map(); // todoId -> { originalEl, cloneEl }
      // Thinking buffers live on each message's .thinking-zone element
      // (Plan 02 Phase 3.4 unified thinking zone) — no globals here.

      // Helper to detect first sentence end
      function findFirstSentenceEnd(text) {
        // Match sentence-ending punctuation followed by space, newline, or end
        var match = text.match(/[.!?](?:\s|$)/);
        return match ? match.index + 1 : -1;
      }

      function handleResponseChunk(chunk) {
        // Perf gate: disabled path is a single boolean check plus one
        // property read for the once-per-response perfSentAt stamp (needed
        // for the always-on coarse send.ttftRender measure).
        if (!perfState.enabled) {
          handleResponseChunkBody(chunk);
          if (chunk.perfSentAt) perfPostFirstChunkRendered(chunk.perfSentAt);
          return;
        }
        var perfT0 = performance.now();
        handleResponseChunkBody(chunk);
        perfRecordChunk(performance.now() - perfT0);
        if (chunk.perfSentAt) perfPostFirstChunkRendered(chunk.perfSentAt);
      }

      function handleResponseChunkBody(chunk) {
        console.log('[Mysti Webview] Received chunk:', JSON.stringify(chunk));
        if (chunk.type === 'text') {
          currentResponse += chunk.content;
          // Strip channel markers from display (actions handled by extension side)
          var displayContent = stripChannelMarkers(currentResponse);
          updateCurrentContentSegment(displayContent);
        } else if (chunk.type === 'thinking') {
          console.log('[Mysti Webview] Thinking content:', JSON.stringify(chunk.content));
          currentThinking += chunk.content;  // Still accumulate for storage
          appendThinkingBlock(chunk.content);  // But display each chunk separately
        }
      }

      function getOrCreateStreamingMessage() {
        var streamingEl = messagesEl.querySelector('.message.streaming:not([data-brainstorm-synthesis])');

        if (!streamingEl) {
          // Remove loading indicator and reset button states when first streaming content arrives
          var loading = messagesEl.querySelector('.loading');
          if (loading) loading.remove();

          // Reset loading state and buttons
          state.isLoading = false;
          if (sendBtn) {
            sendBtn.style.display = 'flex';
            sendBtn.disabled = false;
          }
          if (stopBtn) {
            stopBtn.style.display = 'none';
          }

          streamingEl = document.createElement('div');
          streamingEl.className = 'message assistant streaming';
          // Removed static thinking-block - now created dynamically for each thought
          streamingEl.innerHTML = '<div class="message-header"><div class="message-role-container"><span class="message-role assistant">Mysti</span><span class="message-model-info">' + getModelDisplayName(state.settings.model) + '</span></div></div><div class="message-body"></div>';
          messagesEl.appendChild(streamingEl);
        }

        return streamingEl;
      }

      // ======================================================================
      // Unified thinking zone (Plan 02 Phase 3.4)
      //
      // ONE collapsible component for every provider and every surface (main
      // chat, brainstorm bubbles, restored conversations). 'streamed'
      // thinkers append raw deltas into the zone's buffer; 'complete-blocks'
      // thinkers append whole thoughts as paragraphs — same widget, same
      // collapse/preview behavior. Per-zone state lives on the element
      // itself (_thinkingBuffer / _firstSentenceDone), so no global buffers
      // and no per-agent maps.
      // ======================================================================
      function renderThinkingZone(containerEl, style, content) {
        if (!containerEl || !content) return null;

        var zone = containerEl.querySelector('.thinking-zone');
        if (!zone) {
          zone = document.createElement('div');
          zone.className = 'thinking-block thinking-zone';

          var icon = document.createElement('span');
          icon.className = 'thinking-icon';
          icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>';
          zone.appendChild(icon);

          var preview = document.createElement('span');
          preview.className = 'thinking-preview';
          zone.appendChild(preview);

          var dots = document.createElement('span');
          dots.className = 'thinking-dots';
          zone.appendChild(dots);

          var rest = document.createElement('div');
          rest.className = 'thinking-rest';
          zone.appendChild(rest);

          zone._thinkingBuffer = '';
          zone._firstSentenceDone = false;
          zone.onclick = function() {
            zone.classList.toggle('expanded');
          };
          containerEl.appendChild(zone);
        }

        // 'complete-blocks' appends whole thoughts as paragraphs; 'streamed'
        // appends raw deltas verbatim.
        if (style === 'complete-blocks' && zone._thinkingBuffer) {
          zone._thinkingBuffer += '\n\n' + content;
        } else {
          zone._thinkingBuffer += content;
        }

        var previewSpan = zone.querySelector('.thinking-preview');
        var dotsSpan = zone.querySelector('.thinking-dots');
        var restDiv = zone.querySelector('.thinking-rest');
        var buffer = zone._thinkingBuffer;

        if (!zone._firstSentenceDone) {
          var sentenceEnd = findFirstSentenceEnd(buffer);
          if (sentenceEnd !== -1) {
            // First sentence complete — collapse the rest behind it
            zone._firstSentenceDone = true;
            previewSpan.textContent = buffer.substring(0, sentenceEnd).trim();
            dotsSpan.textContent = ' ...';
            zone.classList.add('collapsible');
            var restText = buffer.substring(sentenceEnd).trim();
            if (restText) {
              restDiv.textContent = restText;
            }
          } else {
            // Still streaming the first sentence
            previewSpan.textContent = buffer;
          }
        } else {
          var sentenceEnd2 = findFirstSentenceEnd(buffer);
          restDiv.textContent = buffer.substring(sentenceEnd2).trim();
        }
        return zone;
      }

      function appendThinkingBlock(thinking) {
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');
        if (thinking && messageBody) {
          renderThinkingZone(messageBody, getThinkingStyle(state.settings.provider), thinking);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function updateCurrentContentSegment(content) {
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');

        // Find or create the current content segment
        var segmentId = 'content-segment-' + contentSegmentIndex;
        var segmentEl = messageBody.querySelector('.' + segmentId);

        if (!segmentEl) {
          segmentEl = document.createElement('div');
          segmentEl.className = 'message-content ' + segmentId;
          messageBody.appendChild(segmentEl);
        }

        segmentEl.innerHTML = formatContent(content);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // Legacy function for backward compatibility
      function updateStreamingMessage(content, thinking) {
        if (thinking) {
          appendThinkingBlock(thinking);
        }
        if (content) {
          updateCurrentContentSegment(content);
        }
      }

      function toggleToolCall(el) {
        el.classList.toggle('expanded');
      }

      // ======================================================================
      // Tool summary (Plan 02 Phase 3.4)
      //
      // Keys off the semantic ToolCall.kind stamped at parse time by every
      // provider (source of truth: toolKind() in src/utils/toolNames.ts —
      // the renderer never re-derives kinds from raw CLI names). The raw
      // tool-name switch below remains as a fallback for legacy persisted
      // tool calls that predate kind stamping, and for kinds whose inputs
      // carry no recognizable summary fields.
      //
      // Accepts a ToolCall-shaped object: { name, input, kind? }.
      // ======================================================================
      function formatToolSummary(toolCall) {
        if (!toolCall) return '';
        var input = toolCall.input;
        if (!input) return '';
        var name = (toolCall.name || '').toLowerCase();

        // 1) Kind-first: provider-agnostic summaries from the semantic kind.
        //    Cases without a confident summary fall through to the raw-name
        //    switch below.
        switch (toolCall.kind) {
          case 'execute':
            if (input.description) return cleanPathsInString(input.description);
            if (input.command) return cleanPathsInString(input.command);
            break;
          case 'read':
          case 'edit':
          case 'delete': {
            var kindPath = input.file_path || input.notebook_path || input.path;
            if (kindPath) return makeRelativePath(kindPath);
            break;
          }
          case 'move': {
            var movePath = input.file_path || input.path || input.source || input.old_path;
            var moveDest = input.destination || input.new_path || input.newPath;
            if (movePath && moveDest) return makeRelativePath(movePath) + ' \u2192 ' + makeRelativePath(moveDest);
            if (movePath) return makeRelativePath(movePath);
            break;
          }
          case 'search': {
            var kindPattern = input.pattern || input.query || '';
            var kindDir = input.path ? makeRelativePath(input.path) : '';
            if (kindPattern && kindDir) return kindPattern + ' in ' + kindDir;
            if (kindPattern || kindDir) return kindPattern || kindDir;
            break;
          }
          case 'fetch':
            if (input.url) return input.url;
            if (input.query) return input.query;
            break;
          case 'think':
            if (input.todos && typeof input.todos.length === 'number') {
              return input.todos.length + ' item' + (input.todos.length !== 1 ? 's' : '');
            }
            break;
          default:
            // No kind (legacy persisted call) or 'other' — raw-name fallback.
            break;
        }

        // 2) Raw-name fallback (legacy tool calls without kind, and kinds
        //    whose inputs had no recognizable fields).
        switch (name) {
          case 'bash':
            // Show description if available (often contains what the command does)
            // Otherwise show command with paths cleaned up
            if (input.description) {
              return cleanPathsInString(input.description);
            }
            return cleanPathsInString(input.command || '');
          case 'read':
            return makeRelativePath(input.file_path || input.path || '');
          case 'write':
            return makeRelativePath(input.file_path || input.path || '');
          case 'edit':
            return makeRelativePath(input.file_path || input.path || '');
          case 'notebookedit':
            return makeRelativePath(input.notebook_path || input.path || '');
          case 'glob':
            // Show pattern and relative path if specified
            var globPattern = input.pattern || '';
            var globPath = input.path ? makeRelativePath(input.path) : '';
            return globPath ? globPattern + ' in ' + globPath : globPattern;
          case 'grep':
            // Show pattern and relative path if specified
            var grepPattern = input.pattern || '';
            var grepPath = input.path ? makeRelativePath(input.path) : '';
            return grepPath ? grepPattern + ' in ' + grepPath : grepPattern;
          case 'webfetch':
            return input.url || '';
          case 'websearch':
            return input.query || '';
          case 'task':
            return input.description || input.prompt?.substring(0, 50) || '';
          case 'todowrite':
            var todos = input.todos || [];
            return todos.length + ' item' + (todos.length !== 1 ? 's' : '');
          default:
            // Try common field names - apply makeRelativePath to potential file paths
            var filePath = input.file_path || input.path || '';
            if (filePath) return makeRelativePath(filePath);
            return cleanPathsInString(input.command || '') || input.query || input.pattern || '';
        }
      }

      // ======================================================================
      // Tool card component (Plan 02 Phase 3.4)
      //
      // ONE card builder shared by the live stream path (handleToolUse) and
      // the restored-conversation replay (addMessage) so reloaded
      // conversations render pixel-identical tool cards. Expand/copy clicks
      // are event-delegated on messagesEl, so cards work in both paths
      // without per-card listeners.
      // ======================================================================
      function buildToolCallElement(toolCall) {
        // Use actual status from toolCall, default to 'running'
        var toolStatus = toolCall.status || 'running';

        var div = document.createElement('div');
        div.className = 'tool-call ' + toolStatus;
        div.dataset.id = toolCall.id;

        // Format input for display
        var inputStr = JSON.stringify(toolCall.input || {}, null, 2);
        var summary = formatToolSummary(toolCall);
        div.dataset.summary = summary;

        // Chevron SVG for expand indicator
        var chevronSvg = '<svg class="tool-call-chevron" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">' +
          '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

        // Spinner SVG for running state (also used for pending)
        var spinnerSvg = '<svg class="tool-call-spinner" viewBox="0 0 16 16" width="12" height="12">' +
          '<circle cx="8" cy="8" r="6" stroke="var(--vscode-charts-blue)" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8" stroke-linecap="round"/></svg>';

        // Copy icon SVG
        var copySvg = '<svg class="tool-call-copy-icon" viewBox="0 0 16 16" fill="currentColor" width="14" height="14">' +
          '<path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/></svg>';

        // Truncation note (persistence caps long input/output strings —
        // ConversationManager PERSISTED_TOOL_STRING_CAP)
        var truncatedNote = toolCall.truncated
          ? '<span class="tool-call-note" title="Input/output were truncated for storage">truncated</span>'
          : '';

        div.innerHTML =
          '<div class="tool-call-header">' +
            spinnerSvg +
            chevronSvg +
            '<span class="tool-call-name">' + escapeHtml(toolCall.name) + '</span>' +
            '<span class="tool-call-summary">' + escapeHtml(summary) + '</span>' +
            truncatedNote +
            '<span class="tool-call-status ' + toolStatus + '">' + toolStatus + '</span>' +
            '<button class="tool-call-copy" title="Copy to clipboard">' + copySvg + '</button>' +
          '</div>' +
          '<div class="tool-call-details">' +
            '<div class="tool-call-section">' +
              '<div class="tool-call-label">Input</div>' +
              '<pre class="tool-call-content">' + escapeHtml(inputStr) + '</pre>' +
            '</div>' +
            '<div class="tool-call-output-section" style="display:none;">' +
              '<div class="tool-call-label">Output</div>' +
              '<pre class="tool-call-output-content"></pre>' +
            '</div>' +
          '</div>';

        // Output already known (restored messages) — show it
        if (toolCall.output) {
          var outputSection = div.querySelector('.tool-call-output-section');
          var outputContent = div.querySelector('.tool-call-output-content');
          if (outputSection && outputContent) {
            outputSection.style.display = 'block';
            outputContent.textContent = toolCall.output.substring(0, 1000) + (toolCall.output.length > 1000 ? '...' : '');
          }
        }

        return div;
      }

      function handleToolUse(toolCall) {
        // Store tool data for later lookup when result arrives
        // (tool_result events don't include name or input)
        if (toolCall.id && toolCall.name) {
          pendingToolData.set(toolCall.id, {
            name: toolCall.name,
            input: toolCall.input || {},
            kind: toolCall.kind
          });
        }

        // Check if this tool call already exists (update with complete input)
        // — Claude/Qwen emit tool_use twice per tool (content_block_start
        // with empty input, content_block_stop with parsed input, same id),
        // so cards are upserted by id.
        var existingEl = messagesEl.querySelector('.tool-call[data-id="' + toolCall.id + '"]');

        if (existingEl) {
          // Update existing element with complete input
          var inputContent = existingEl.querySelector('.tool-call-content');
          if (inputContent && toolCall.input && Object.keys(toolCall.input).length > 0) {
            var inputStr = JSON.stringify(toolCall.input, null, 2);
            inputContent.textContent = inputStr;
          }
          // Update summary if we now have input
          var summaryEl = existingEl.querySelector('.tool-call-summary');
          if (summaryEl && toolCall.input) {
            var summary = formatToolSummary(toolCall);
            summaryEl.textContent = summary;
            existingEl.dataset.summary = summary;
          }
          return;
        }

        // Get or create streaming message
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');

        // If there's content in the current segment, finalize it and start a new segment
        if (currentResponse.trim()) {
          contentSegmentIndex++;
          currentResponse = '';
        }

        // Append tool call directly to message body (interleaved with content segments)
        messageBody.appendChild(buildToolCallElement(toolCall));
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function handleToolResult(toolCall) {
        var toolEl = messagesEl.querySelector('.tool-call[data-id="' + toolCall.id + '"]');
        if (toolEl) {
          // Update status badge
          var statusEl = toolEl.querySelector('.tool-call-status');
          statusEl.className = 'tool-call-status ' + toolCall.status;
          statusEl.textContent = toolCall.status;

          // Add status class to the tool call element for background styling
          toolEl.classList.remove('running');
          toolEl.classList.add(toolCall.status);

          // Show output if available
          if (toolCall.output) {
            var outputSection = toolEl.querySelector('.tool-call-output-section');
            var outputContent = toolEl.querySelector('.tool-call-output-content');
            outputSection.style.display = 'block';
            outputContent.textContent = toolCall.output.substring(0, 1000) + (toolCall.output.length > 1000 ? '...' : '');
          }

          // CRITICAL: Retrieve stored tool data (name and input are empty in tool_result)
          var storedData = pendingToolData.get(toolCall.id);
          var toolName = storedData ? storedData.name : toolCall.name;
          var toolInput = storedData ? storedData.input : toolCall.input;

          // For file edit tools, AUGMENT with structured report card below
          if (isFileEditTool(toolName)) {
            var editInfo = parseFileEditInfo(toolName, toolInput || {}, toolCall.output || '');

            // Check if edit report card already exists for this tool
            var existingCard = toolEl.parentNode.querySelector('.edit-report-card[data-tool-id="' + toolCall.id + '"]');
            if (!existingCard && editInfo.filePath) {
              // Create and insert edit report card below the tool call
              var cardHtml = renderEditReportCard(editInfo, currentThinking);
              var cardWrapper = document.createElement('div');
              cardWrapper.innerHTML = cardHtml;
              var cardEl = cardWrapper.firstChild;
              cardEl.dataset.toolId = toolCall.id;

              // Insert after the tool call element
              if (toolEl.nextSibling) {
                toolEl.parentNode.insertBefore(cardEl, toolEl.nextSibling);
              } else {
                toolEl.parentNode.appendChild(cardEl);
              }

              // Request actual file line number from extension
              var searchText = toolInput.old_string || toolInput.content || '';
              if (searchText && editInfo.filePath) {
                postMessageWithPanelId({
                  type: 'getFileLineNumber',
                  filePath: editInfo.filePath,
                  searchText: searchText
                });
              }

              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }

          // For TodoWrite, render a nice todo list and update sticky progress
          if (toolName && toolName.toLowerCase() === 'todowrite') {
            var todoInput = toolInput;
            if (todoInput && todoInput.todos && todoInput.todos.length > 0) {
              // Remove any existing todo list for this tool
              var existingTodoList = toolEl.querySelector('.todo-list');
              if (existingTodoList) {
                existingTodoList.remove();
              }

              var todoListHtml = renderTodoList(todoInput.todos);
              var todoContainer = document.createElement('div');
              todoContainer.innerHTML = todoListHtml;
              toolEl.appendChild(todoContainer.firstChild);

              // Update sticky progress indicator
              updateStickyTodos(todoInput.todos);
            }
          }

          // Clean up stored data
          pendingToolData.delete(toolCall.id);
        }
      }

      // ========================================
      // Channel Action Handling Functions
      // ========================================

      function handleChannelAction(payload) {
        // For inbound messages, attach to last message (any type) since agent may be idle
        var targetEl;
        if (payload.action === 'inbound') {
          targetEl = messagesEl.querySelector('.message:last-child');
        } else {
          targetEl = messagesEl.querySelector('.message.streaming') || messagesEl.querySelector('.message.assistant:last-child');
        }
        if (!targetEl) return;

        var messageBody = targetEl.querySelector('.message-body');
        if (!messageBody) return;

        var card = document.createElement('div');
        var actionType = payload.action || 'send';
        card.className = 'channel-action-card ' + actionType;

        var icon = actionType === 'send' ? '📨' : actionType === 'ask' ? '❓' : actionType === 'delegate' ? '🤖' : actionType === 'inbound' ? '📥' : actionType === 'queued' ? '📩' : '📩';
        var channelName = (payload.channel || 'channel').charAt(0).toUpperCase() + (payload.channel || 'channel').slice(1);
        var recipientLabel = payload.to ? ' to ' + payload.to : '';
        var senderLabel = payload.sender ? ' from ' + payload.sender : '';
        var statusText = '';
        var statusClass = '';

        if (actionType === 'send') {
          statusText = payload.success ? 'Sent' : 'Failed';
          statusClass = payload.success ? '' : 'failed';
        } else if (actionType === 'ask') {
          statusText = 'Waiting for reply...';
          statusClass = 'waiting';
        } else if (actionType === 'delegate') {
          statusText = payload.success ? 'Delegated' : 'Failed';
          statusClass = payload.success ? '' : 'failed';
        } else if (actionType === 'inbound') {
          statusText = 'Received';
          statusClass = '';
        } else if (actionType === 'queued') {
          statusText = 'Queued';
          statusClass = 'waiting';
          icon = '📩';
        }

        var label = channelName + (actionType === 'inbound' ? senderLabel : recipientLabel);
        card.innerHTML = '<span class="channel-action-icon">' + icon + '</span>' +
          '<span class="channel-action-text">' + label + '</span>' +
          '<span class="channel-action-status ' + statusClass + '">' + statusText + '</span>';

        messageBody.appendChild(card);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      /** Strip channel markers from content for clean display */
      function stripChannelMarkers(text) {
        return text
          .replace(/<<<(?:CHANNEL_(?:SEND|ASK)\s+[^>]*|OPENCLAW)>>>([\s\S]*?)<<<END_(?:CHANNEL_(?:SEND|ASK)|OPENCLAW)>>>/g, '')
          // Plan 04 Phase 4: hide the DeepMyst connect marker — it's rendered as
          // a "Link <service>" card by the extension, not shown as raw text.
          .replace(/<<<MYSTI_CONNECT:[a-z0-9._-]*>>>/gi, '');
      }

      // ========================================
      // Plan 04 Phase 4: DeepMyst connect cards
      // ========================================

      function _prettyServiceName(slug) {
        return String(slug || 'service')
          .split(/[-_]/)
          .filter(Boolean)
          .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); })
          .join(' ');
      }

      function _connectTargetMessageBody() {
        var targetEl = messagesEl.querySelector('.message.streaming') ||
          messagesEl.querySelector('.message.assistant:last-child');
        if (!targetEl) { return null; }
        return targetEl.querySelector('.message-body');
      }

      /** Render a "Link <service>" button when an agent requests a connection. */
      function handleConnectionRequired(payload) {
        var body = _connectTargetMessageBody();
        if (!body) { return; }
        var service = (payload && payload.service) || 'service';
        // Don't stack duplicate cards for the same service in one message.
        if (body.querySelector('.connect-card[data-service="' + service + '"]')) { return; }
        var pretty = _prettyServiceName(service);

        var card = document.createElement('div');
        card.className = 'connect-card';
        card.setAttribute('data-service', service);

        var info = document.createElement('div');
        info.className = 'connect-card-info';
        info.innerHTML = '<span class="connect-card-icon">🔌</span>' +
          '<span class="connect-card-text">Connect <strong>' + pretty + '</strong> through DeepMyst</span>';

        var btn = document.createElement('button');
        btn.className = 'connect-card-btn';
        btn.textContent = (payload && payload.signedIn) ? 'Link ' + pretty : 'Sign in to link ' + pretty;
        btn.addEventListener('click', function () {
          vscode.postMessage({ type: 'connectService', service: service });
          btn.textContent = 'Opening sign-in…';
          btn.disabled = true;
        });

        card.appendChild(info);
        card.appendChild(btn);
        body.appendChild(card);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      /** Flip a connect card to connected/failed after the OAuth round-trip. */
      function handleConnectionResult(payload) {
        var service = (payload && payload.service) || 'service';
        var card = messagesEl.querySelector('.connect-card[data-service="' + service + '"]');
        if (!card) { return; }
        var pretty = _prettyServiceName(service);
        if (payload && payload.ok) {
          card.className = 'connect-card connected';
          card.innerHTML = '<div class="connect-card-info">' +
            '<span class="connect-card-icon">✅</span>' +
            '<span class="connect-card-text"><strong>' + pretty + '</strong> connected</span>' +
            '</div>';
        } else {
          var btn = card.querySelector('.connect-card-btn');
          if (btn) { btn.textContent = 'Retry ' + pretty; btn.disabled = false; }
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      /** Subtle note when the service is already linked in DeepMyst. */
      function handleConnectionAlready(payload) {
        var body = _connectTargetMessageBody();
        if (!body) { return; }
        var service = (payload && payload.service) || 'service';
        if (body.querySelector('.connect-card[data-service="' + service + '"]')) { return; }
        var pretty = _prettyServiceName(service);

        var card = document.createElement('div');
        card.className = 'connect-card connected';
        card.setAttribute('data-service', service);
        card.innerHTML = '<div class="connect-card-info">' +
          '<span class="connect-card-icon">✅</span>' +
          '<span class="connect-card-text"><strong>' + pretty + '</strong> is already connected</span>' +
          '</div>';
        body.appendChild(card);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // ========================================
      // Permission Handling Functions
      // ========================================

      function handlePermissionRequest(request) {
        // Store in state
        state.pendingPermissions.set(request.id, request);

        // Render permission card
        var card = renderPermissionCard(request);
        messagesEl.appendChild(card);

        // Start timer countdown
        if (request.expiresAt > 0) {
          startPermissionTimer(request.id, request.expiresAt);
        }

        // Focus for keyboard navigation
        card.focus();
        state.focusedPermissionId = request.id;

        scrollToBottom();
      }

      function renderPermissionCard(request) {
        var card = document.createElement('div');
        var cardClass = 'permission-card pending';
        if (request.semiAutonomous) {
          cardClass += ' semi-autonomous';
        }
        card.className = cardClass;
        card.dataset.id = request.id;
        card.tabIndex = 0;

        // Build question-framed title
        var questionTitle = buildPermissionQuestion(request);

        // Timer
        var timeRemaining = request.expiresAt > 0 ? Math.max(0, request.expiresAt - Date.now()) : 0;
        var timerClass = timeRemaining > 0 && timeRemaining < 10000 ? 'critical' :
                         timeRemaining > 0 && timeRemaining < 20000 ? 'warning' : '';
        var timerText;
        if (request.semiAutonomous && request.expiresAt > 0) {
          timerText = 'AI decides in ' + formatTimeRemaining(timeRemaining);
        } else if (request.expiresAt > 0) {
          timerText = formatTimeRemaining(timeRemaining);
        } else {
          timerText = '';
        }

        // Paused indicator
        var pausedHtml = request.details.suspended
          ? '<span><span class="permission-paused-dot"></span>Paused</span>'
          : '';

        card.innerHTML =
          '<div class="permission-question">' + escapeHtml(questionTitle) + '</div>' +
          '<div class="permission-details-toggle" data-target="details-' + request.id + '">Show details</div>' +
          '<div class="permission-details" id="details-' + request.id + '">' +
            renderPermissionDetails(request) +
          '</div>' +
          '<div class="permission-options">' +
            '<button class="permission-option approve-option" data-action="approve">' +
              '<span class="option-number">1</span>' +
              '<span>Yes</span>' +
            '</button>' +
            '<button class="permission-option" data-action="always-allow">' +
              '<span class="option-number">2</span>' +
              "<span>Yes, and don't ask again this session</span>" +
            '</button>' +
            '<button class="permission-option" data-action="deny">' +
              '<span class="option-number">3</span>' +
              '<span>No</span>' +
            '</button>' +
          '</div>' +
          '<div class="permission-custom-input">' +
            '<input type="text" placeholder="Tell Mysti what to do instead..." data-request-id="' + request.id + '" />' +
          '</div>' +
          '<div class="permission-footer">' +
            '<span>Esc to cancel' + (pausedHtml ? ' · ' : '') + pausedHtml + '</span>' +
            (timerText ? '<span class="permission-timer ' + timerClass + '" data-expires="' + request.expiresAt + '">' + timerText + '</span>' : '') +
          '</div>';

        // Add click handlers to option buttons
        card.querySelectorAll('.permission-option').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = btn.dataset.action;
            handlePermissionAction(request.id, action);
          });
        });

        // Details toggle
        var toggle = card.querySelector('.permission-details-toggle');
        if (toggle) {
          toggle.addEventListener('click', function() {
            var details = card.querySelector('.permission-details');
            if (details) {
              var isExpanded = details.classList.contains('expanded');
              details.classList.toggle('expanded');
              toggle.textContent = isExpanded ? 'Show details' : 'Hide details';
            }
          });
        }

        // Custom instruction input
        var customInput = card.querySelector('.permission-custom-input input');
        if (customInput) {
          customInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && customInput.value.trim()) {
              e.preventDefault();
              e.stopPropagation();
              // Deny the current request and send custom instruction as new message
              handlePermissionAction(request.id, 'deny');
              postMessageWithPanelId({
                type: 'permissionCustomInstruction',
                payload: { text: customInput.value.trim() }
              });
            }
          });
          // Prevent card-level keyboard shortcuts when typing
          customInput.addEventListener('keydown', function(e) {
            e.stopPropagation();
          });
        }

        return card;
      }

      function buildPermissionQuestion(request) {
        var toolName = request.details.toolName || request.title || '';
        var filePath = request.details.filePath || '';

        // Map tool names to question-framed titles
        if (toolName.toLowerCase().includes('edit') || toolName.toLowerCase().includes('write')) {
          if (filePath) {
            return 'Allow write to ' + makeRelativePath(filePath) + '?';
          }
          return 'Allow file write?';
        }
        if (toolName.toLowerCase().includes('bash') || toolName.toLowerCase().includes('command')) {
          var cmd = request.details.command || '';
          if (cmd) {
            return 'Allow ' + cmd.substring(0, 60) + (cmd.length > 60 ? '...' : '') + '?';
          }
          return 'Allow command execution?';
        }
        if (toolName.toLowerCase().includes('read')) {
          if (filePath) {
            return 'Allow read of ' + makeRelativePath(filePath) + '?';
          }
          return 'Allow file read?';
        }
        // Fallback
        return 'Allow ' + escapeHtml(toolName || request.title) + '?';
      }

      function renderPermissionDetails(request) {
        var details = request.details;
        var html = '';

        if (details.filePath) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">File:</span>' +
            '<span class="permission-detail-value">' + makeRelativePath(details.filePath) + '</span>' +
          '</div>';
        }

        if (details.command) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Command:</span>' +
            '<span class="permission-detail-value">' + escapeHtml(details.command.substring(0, 100)) + (details.command.length > 100 ? '...' : '') + '</span>' +
          '</div>';
        }

        if (details.linesAdded !== undefined || details.linesRemoved !== undefined) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Changes:</span>' +
            '<span class="permission-detail-value">' +
              (details.linesAdded ? '+' + details.linesAdded + ' lines ' : '') +
              (details.linesRemoved ? '-' + details.linesRemoved + ' lines' : '') +
            '</span>' +
          '</div>';
        }

        if (details.files && details.files.length > 0) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Files:</span>' +
            '<span class="permission-detail-value">' + details.files.length + ' files</span>' +
          '</div>';
        }

        return html || '<div class="permission-detail-row"><span class="permission-detail-value">' + escapeHtml(request.description) + '</span></div>';
      }

      function formatTimeRemaining(ms) {
        var seconds = Math.ceil(ms / 1000);
        return seconds + 's';
      }

      function startPermissionTimer(requestId, expiresAt) {
        var isSemiAuto = false;
        var card0 = document.querySelector('.permission-card[data-id="' + requestId + '"]');
        if (card0 && card0.classList.contains('semi-autonomous')) {
          isSemiAuto = true;
        }

        var interval = setInterval(function() {
          var card = document.querySelector('.permission-card[data-id="' + requestId + '"]');
          if (!card || !state.pendingPermissions.has(requestId)) {
            clearInterval(interval);
            return;
          }

          var timerEl = card.querySelector('.permission-timer');
          var remaining = expiresAt - Date.now();

          if (remaining <= 0) {
            clearInterval(interval);
            if (isSemiAuto && timerEl) {
              timerEl.textContent = 'AI deciding...';
            }
            return; // Backend will handle expiration
          }

          timerEl.textContent = isSemiAuto
            ? 'AI decides in ' + formatTimeRemaining(remaining)
            : formatTimeRemaining(remaining);
          timerEl.className = 'permission-timer ' +
            (remaining < 10000 ? 'critical' : remaining < 20000 ? 'warning' : '');
        }, 1000);
      }

      function handlePermissionAction(requestId, action) {
        var card = document.querySelector('.permission-card[data-id="' + requestId + '"]');
        if (!card) return;

        // Update visual state
        card.classList.remove('pending');
        card.classList.add(action === 'deny' ? 'denied' : 'approved');

        // Send response to extension
        postMessageWithPanelId({
          type: 'permissionResponse',
          payload: {
            requestId: requestId,
            decision: action,
            scope: action === 'always-allow' ? 'session' : 'this-action'
          }
        });

        // Remove from state
        state.pendingPermissions.delete(requestId);

        // Auto-remove card after animation
        setTimeout(function() {
          if (card.parentNode) {
            card.remove();
          }
        }, action === 'deny' ? 600 : 500);
      }

      function handlePermissionExpired(payload) {
        var card = document.querySelector('.permission-card[data-id="' + payload.requestId + '"]');
        if (!card) return;

        card.classList.remove('pending');
        card.classList.add('expired');

        // Update UI to show expired state
        var timerEl = card.querySelector('.permission-timer');
        if (timerEl) {
          timerEl.textContent = payload.behavior === 'auto-accept' ? 'Auto-approved' : 'Expired';
        }

        // Hide options and custom input, show status in footer
        var optionsEl = card.querySelector('.permission-options');
        if (optionsEl) { optionsEl.style.display = 'none'; }
        var customEl = card.querySelector('.permission-custom-input');
        if (customEl) { customEl.style.display = 'none'; }
        var footerEl = card.querySelector('.permission-footer');
        if (footerEl) {
          footerEl.innerHTML = '<span style="color: var(--vscode-descriptionForeground);">' +
            (payload.behavior === 'auto-accept' ? 'Auto-approved' : 'Auto-denied') +
            ' (timeout)</span>';
        }
        // Legacy fallback
        var actionsEl = card.querySelector('.permission-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '<span style="color: var(--vscode-descriptionForeground);">Action was ' +
            (payload.behavior === 'auto-accept' ? 'automatically approved' : 'automatically denied') +
            ' due to timeout.</span>';
        }

        // Remove from state
        state.pendingPermissions.delete(payload.requestId);

        // Remove after delay
        setTimeout(function() {
          if (card.parentNode) card.remove();
        }, 3000);
      }

      function handleSemiAutonomousDecision(payload) {
        if (payload.targetType === 'permission') {
          var card = document.querySelector('.permission-card[data-id="' + payload.requestId + '"]');
          if (!card) return;

          card.classList.remove('pending');
          card.classList.add(payload.approved ? 'approved' : 'denied');

          // Update timer to show decision
          var timerEl = card.querySelector('.permission-timer');
          if (timerEl) {
            timerEl.textContent = payload.approved ? 'AI Approved' : 'AI Denied';
          }

          // Replace actions with decision feedback
          var actionsEl = card.querySelector('.permission-actions');
          if (actionsEl) {
            var safetyIcon = payload.safetyLevel === 'blocked' ? '&#x1F6D1;' :
                             payload.safetyLevel === 'caution' ? '&#x26A0;&#xFE0F;' : '&#x2705;';
            actionsEl.innerHTML =
              '<div class="semi-autonomous-feedback">' +
                '<span class="feedback-icon">' + safetyIcon + '</span>' +
                '<div>' +
                  '<div>AI ' + (payload.approved ? 'approved' : 'denied') + ' this action</div>' +
                  '<div class="feedback-reasoning">' + escapeHtml(payload.reasoning || '') + '</div>' +
                '</div>' +
              '</div>';
          }

          // Clean up state
          state.pendingPermissions.delete(payload.requestId);

          // Remove card after delay
          setTimeout(function() {
            if (card.parentNode) card.remove();
          }, payload.approved ? 2000 : 3000);

        } else if (payload.targetType === 'question') {
          var container = document.querySelector(
            '.ask-user-question-container[data-tool-call-id="' + payload.requestId + '"]'
          );
          if (!container) return;

          // Remove the timer bar if present
          var timerBar = container.querySelector('.auq-semi-auto-timer');
          if (timerBar) timerBar.remove();

          // Replace content with AI decision feedback
          container.innerHTML =
            '<div class="semi-autonomous-feedback">' +
              '<span class="feedback-icon">&#x1F916;</span>' +
              '<div>' +
                '<div>AI answered on your behalf</div>' +
                '<div class="feedback-reasoning">' + escapeHtml(payload.reasoning || '') + '</div>' +
              '</div>' +
            '</div>';

          container.classList.add('submitted');

          setTimeout(function() {
            if (container.parentNode) container.remove();
          }, 3000);
        }
      }

      function handleSemiAutoQuestionTimer(payload) {
        var container = document.querySelector(
          '.ask-user-question-container[data-tool-call-id="' + payload.toolCallId + '"]'
        );
        if (!container) return;

        // Insert timer bar at the top of the container
        var timerBar = document.createElement('div');
        timerBar.className = 'auq-semi-auto-timer';
        timerBar.innerHTML =
          '<span>&#x1F916; AI will answer if no response</span>' +
          '<span class="timer-text">in ' + payload.timeout + 's</span>';
        container.insertBefore(timerBar, container.firstChild);

        // Start countdown
        var interval = setInterval(function() {
          if (!document.body.contains(timerBar)) {
            clearInterval(interval);
            return;
          }
          var remaining = payload.expiresAt - Date.now();
          if (remaining <= 0) {
            clearInterval(interval);
            var timerText = timerBar.querySelector('.timer-text');
            if (timerText) timerText.textContent = 'AI deciding...';
            return;
          }
          var timerText = timerBar.querySelector('.timer-text');
          if (timerText) timerText.textContent = 'in ' + Math.ceil(remaining / 1000) + 's';
        }, 1000);
      }

      function handleSemiAutoPlanTimer(payload) {
        var container = document.querySelector(
          '.plan-options-container[data-message-id]'
        );
        if (!container) return;

        // Store syntheticPlanId on container for skip button
        container.setAttribute('data-synthetic-plan-id', payload.syntheticPlanId);

        // Insert timer bar at the top of the container (same style as question timer)
        var timerBar = document.createElement('div');
        timerBar.className = 'auq-semi-auto-timer plan-semi-auto-timer';
        timerBar.innerHTML =
          '<span>&#x1F916; AI will select an approach if no response</span>' +
          '<span class="timer-text">in ' + payload.timeout + 's</span>';
        container.insertBefore(timerBar, container.firstChild);

        // Start countdown (reuse same pattern as question timer)
        var interval = setInterval(function() {
          if (!document.body.contains(timerBar)) {
            clearInterval(interval);
            return;
          }
          var remaining = payload.expiresAt - Date.now();
          if (remaining <= 0) {
            clearInterval(interval);
            var timerText = timerBar.querySelector('.timer-text');
            if (timerText) timerText.textContent = 'AI selecting...';
            return;
          }
          var timerText = timerBar.querySelector('.timer-text');
          if (timerText) timerText.textContent = 'in ' + Math.ceil(remaining / 1000) + 's';
        }, 1000);
      }

      // Keyboard shortcuts for permission cards
      function handlePermissionKeyboard(e) {
        // Check if typing in custom input — don't intercept
        if (e.target && e.target.closest && e.target.closest('.permission-custom-input')) {
          return false;
        }

        var focusedCard = document.querySelector('.permission-card:focus');
        // Also check for any pending permission card (for global shortcuts)
        if (!focusedCard) {
          focusedCard = document.querySelector('.permission-card.pending');
        }
        if (!focusedCard) return false;

        var requestId = focusedCard.dataset.id;

        switch(e.key) {
          case '1':
            e.preventDefault();
            handlePermissionAction(requestId, 'approve');
            return true;
          case '2':
            e.preventDefault();
            handlePermissionAction(requestId, 'always-allow');
            return true;
          case '3':
            e.preventDefault();
            handlePermissionAction(requestId, 'deny');
            return true;
          case 'Enter':
            e.preventDefault();
            handlePermissionAction(requestId, 'approve');
            return true;
          case 'Escape':
            e.preventDefault();
            handlePermissionAction(requestId, 'deny');
            return true;
        }
        return false;
      }

      // ========================================
      // Plan Option Selection Handlers
      // ========================================

      // Render plan options as interactive cards
      function renderPlanOptions(options, messageId, originalQuery, metaQuestions, syntheticPlanId, origin) {
        if (!options || options.length === 0) return null;

        // Plan 02 Phase 3.5: native plan moments (exit_plan_mode) reuse this
        // exact card path — origin = { source: 'exit-plan-mode',
        // planFilePath: string|null } labels the card; everything else
        // (selection round trip, semi-auto timer, dismiss) is unchanged.
        var isNativePlan = !!(origin && origin.source === 'exit-plan-mode');

        var container = document.createElement('div');
        container.className = 'plan-options-container' + (isNativePlan ? ' native-plan' : '');
        container.setAttribute('data-message-id', messageId);
        container.setAttribute('data-original-query', originalQuery || '');
        if (syntheticPlanId) {
          container.setAttribute('data-synthetic-plan-id', syntheticPlanId);
        }
        if (isNativePlan) {
          container.setAttribute('data-plan-source', origin.source);
        }

        // Render meta-questions if present (informational only)
        if (metaQuestions && metaQuestions.length > 0) {
          var metaSection = document.createElement('div');
          metaSection.className = 'meta-questions-section';
          metaSection.style.marginBottom = '16px';
          metaSection.style.padding = '12px 16px';
          metaSection.style.background = 'var(--vscode-editor-background)';
          metaSection.style.border = '1px solid var(--vscode-panel-border)';
          metaSection.style.borderRadius = '6px';
          metaSection.style.fontSize = '14px';
          metaSection.style.lineHeight = '1.5';

          metaQuestions.forEach(function(q) {
            var questionText = document.createElement('div');
            questionText.className = 'meta-question-text';
            questionText.style.marginBottom = '4px';
            questionText.textContent = q.question;
            metaSection.appendChild(questionText);
          });

          container.appendChild(metaSection);
        }

        var header = document.createElement('div');
        header.className = 'plan-options-header';
        if (isNativePlan) {
          var planFileHint = origin.planFilePath
            ? makeRelativePath(origin.planFilePath)
            : 'Review and approve to continue';
          header.innerHTML =
            '<span class="plan-options-title">📋 Plan ready for review</span>' +
            '<span class="plan-options-hint" title="' + escapeHtml(origin.planFilePath || '') + '">' + escapeHtml(planFileHint) + '</span>';
        } else {
          header.innerHTML =
            '<span class="plan-options-title">📋 Select an approach</span>' +
            '<span class="plan-options-hint">Choose how to proceed</span>';
        }

        // Add dismiss button
        var skipBtn = document.createElement('button');
        skipBtn.className = 'plan-options-skip-btn';
        skipBtn.textContent = '✕';
        skipBtn.title = 'Dismiss';
        skipBtn.style.cssText = 'background: none; border: none; color: var(--vscode-descriptionForeground); padding: 4px; cursor: pointer; font-size: 14px; margin-left: auto; opacity: 0.6; line-height: 1;';
        skipBtn.onmouseenter = function() { skipBtn.style.opacity = '1'; };
        skipBtn.onmouseleave = function() { skipBtn.style.opacity = '0.6'; };
        skipBtn.onclick = function() {
          var planId = container.getAttribute('data-synthetic-plan-id') || '';
          postMessageWithPanelId({
            type: 'planOptionsSkipped',
            payload: { syntheticPlanId: planId }
          });
          container.remove();
        };
        header.appendChild(skipBtn);

        container.appendChild(header);

        options.forEach(function(option, index) {
          var card = createPlanOptionCard(option, messageId, index);
          container.appendChild(card);
        });

        return container;
      }

      // Create a single plan option card
      function createPlanOptionCard(option, messageId, index) {
        var card = document.createElement('div');
        card.className = 'plan-option-card plan-option-collapsed';
        card.setAttribute('data-id', option.id);
        card.setAttribute('data-color', option.color || 'blue');
        card.setAttribute('tabindex', '0');

        // Build pros list
        var prosHtml = '';
        if (option.pros && option.pros.length > 0) {
          prosHtml = '<div class="plan-option-pros">' +
            '<div class="plan-option-pros-title">✓ Pros</div>' +
            '<ul class="plan-option-list">' +
            option.pros.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') +
            '</ul></div>';
        }

        // Build cons list
        var consHtml = '';
        if (option.cons && option.cons.length > 0) {
          consHtml = '<div class="plan-option-cons">' +
            '<div class="plan-option-cons-title">✗ Cons</div>' +
            '<ul class="plan-option-list">' +
            option.cons.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') +
            '</ul></div>';
        }

        // Build pros/cons section
        var prosConsHtml = '';
        if (prosHtml || consHtml) {
          prosConsHtml = '<div class="plan-option-proscons">' + prosHtml + consHtml + '</div>';
        }

        card.innerHTML =
          '<div class="plan-option-header">' +
            '<div class="plan-option-number">' + (index + 1) + '</div>' +
            '<div class="plan-option-title-area">' +
              '<div class="plan-option-title">' +
                escapeHtml(option.title) +
                '<span class="plan-option-complexity ' + (option.complexity || 'medium') + '">' +
                  (option.complexity || 'medium') +
                '</span>' +
              '</div>' +
              '<div class="plan-option-summary">' + escapeHtml(option.summary || '') + '</div>' +
            '</div>' +
            '<span class="plan-option-chevron">▸</span>' +
          '</div>' +
          prosConsHtml +
          '<div class="plan-option-actions">' +
            '<button class="plan-execute-btn edit-auto" data-mode="edit-automatically">Execute Automatically</button>' +
            '<button class="plan-execute-btn ask-first" data-mode="ask-before-edit">Ask Before Each Edit</button>' +
            '<button class="plan-execute-btn keep-planning" data-mode="quick-plan">Keep Planning</button>' +
          '</div>' +
          '<div class="plan-custom-instructions">' +
            '<button class="custom-instructions-toggle">Add custom instructions</button>' +
            '<div class="custom-instructions-input hidden">' +
              '<textarea class="custom-instructions-textarea" placeholder="Add any additional instructions or constraints..."></textarea>' +
            '</div>' +
          '</div>';

        // Event handlers for execution buttons
        card.querySelectorAll('.plan-execute-btn').forEach(function(btn) {
          btn.onclick = function(e) {
            e.stopPropagation();
            var mode = btn.getAttribute('data-mode');
            var textarea = card.querySelector('.custom-instructions-textarea');
            var customInstructions = textarea ? textarea.value : '';
            handlePlanOptionSelect(option, messageId, mode, customInstructions);
          };
        });

        // Toggle custom instructions visibility
        var toggleBtn = card.querySelector('.custom-instructions-toggle');
        var inputDiv = card.querySelector('.custom-instructions-input');
        if (toggleBtn && inputDiv) {
          toggleBtn.onclick = function(e) {
            e.stopPropagation();
            inputDiv.classList.toggle('hidden');
            toggleBtn.textContent = inputDiv.classList.contains('hidden')
              ? 'Add custom instructions'
              : 'Hide custom instructions';
          };
        }

        card.onclick = function(e) {
          if (e.target.classList.contains('plan-execute-btn') ||
              e.target.classList.contains('custom-instructions-toggle') ||
              e.target.classList.contains('custom-instructions-textarea')) return;
          // Toggle expansion or select
          card.classList.toggle('plan-option-collapsed');
        };

        // Keyboard support - default to 'edit-automatically' on Enter
        card.onkeydown = function(e) {
          if (e.key === 'Enter' && e.target === card) {
            e.preventDefault();
            var textarea = card.querySelector('.custom-instructions-textarea');
            var customInstructions = textarea ? textarea.value : '';
            handlePlanOptionSelect(option, messageId, 'edit-automatically', customInstructions);
          }
        };

        return card;
      }

      // Handle plan option selection
      function handlePlanOptionSelect(option, messageId, executionMode, customInstructions) {
        var container = document.querySelector('.plan-options-container[data-message-id="' + messageId + '"]');
        var originalQuery = container ? container.getAttribute('data-original-query') : '';

        // Mark as selected
        var cards = document.querySelectorAll('.plan-option-card');
        cards.forEach(function(c) { c.classList.remove('selected'); });
        var selectedCard = document.querySelector('.plan-option-card[data-id="' + option.id + '"]');
        if (selectedCard) {
          selectedCard.classList.add('selected');
        }

        // Send selection to backend with execution mode and custom instructions
        postMessageWithPanelId({
          type: 'planOptionSelected',
          payload: {
            selectedPlan: option,
            originalQuery: originalQuery,
            messageId: messageId,
            executionMode: executionMode,
            customInstructions: customInstructions || ''
          }
        });
      }

      // Handle planOptions message from backend
      function handlePlanOptionsMessage(payload) {
        if (!payload.options || payload.options.length === 0) return;

        // Find the message to attach plan options to
        var messageEl = document.querySelector('.message[data-id="' + payload.messageId + '"]');
        if (!messageEl) {
          // Find most recent assistant message
          var messages = document.querySelectorAll('.message.assistant');
          messageEl = messages[messages.length - 1];
        }

        if (messageEl) {
          // Remove any existing plan options
          var existing = messageEl.querySelector('.plan-options-container');
          if (existing) existing.remove();

          // Add new plan options (with optional meta-questions). Native
          // exit-plan moments (Plan 02 Phase 3.5) carry the ADDITIVE
          // source/planFilePath fields on the same payload — pass them
          // through so the card is labeled as a native plan.
          var planContainer = renderPlanOptions(
            payload.options,
            payload.messageId,
            payload.originalQuery,
            payload.metaQuestions,
            payload.syntheticPlanId,
            payload.source ? { source: payload.source, planFilePath: payload.planFilePath || null } : undefined
          );
          if (planContainer) {
            messageEl.appendChild(planContainer);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }

      // ========================================
      // AskUserQuestion Handlers (unified for both tool-based and text-detected questions)
      // ========================================

      // Handle native AskUserQuestion tool from Claude Code CLI
      function handleAskUserQuestionMessage(payload) {
        if (!payload || !payload.questions || payload.questions.length === 0) return;

        // Find most recent assistant message
        var messages = document.querySelectorAll('.message.assistant');
        var messageEl = messages[messages.length - 1];

        if (messageEl) {
          // Remove any existing AskUserQuestion container
          var existing = messageEl.querySelector('.ask-user-question-container');
          if (existing) existing.remove();

          // For detected questions, hide the matching question text in the response body
          // so it doesn't appear both as text and as an interactive card
          if (payload.source === 'detected') {
            hideDetectedQuestionText(messageEl, payload.questions);
          }

          // Add tabbed question UI
          var container = renderAskUserQuestionTabs(payload.toolCallId, payload.questions);
          if (container) {
            messageEl.appendChild(container);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }

      // Hide question text in the response body that duplicates the interactive card
      function hideDetectedQuestionText(messageEl, questions) {
        var contentEl = messageEl.querySelector('.content');
        if (!contentEl) return;

        // Build a set of normalized question strings to match against
        var questionTexts = questions.map(function(q) {
          return q.question.trim().toLowerCase().replace(/\?$/, '').trim();
        });

        // Search through paragraphs and list items for matching question text
        var candidates = contentEl.querySelectorAll('p, li');
        candidates.forEach(function(el) {
          var text = (el.textContent || '').trim().toLowerCase().replace(/\?$/, '').trim();
          if (!text) return;

          for (var i = 0; i < questionTexts.length; i++) {
            // Match if the element text is the question or ends with it
            // (handles cases like "- What would you like to work on today?")
            if (text === questionTexts[i] || text.endsWith(questionTexts[i])) {
              el.style.display = 'none';
              break;
            }
          }
        });
      }

      function renderAskUserQuestionTabs(toolCallId, questions) {
        var container = document.createElement('div');
        container.className = 'ask-user-question-container';
        container.setAttribute('data-tool-call-id', toolCallId);

        // Track answers and current tab
        container._answers = {};
        container._currentTab = 0;
        container._questions = questions;

        // Single question: skip the tab header entirely for a cleaner look
        if (questions.length > 1) {
          var tabHeader = document.createElement('div');
          tabHeader.className = 'auq-tab-header';

          questions.forEach(function(q, idx) {
            var tab = document.createElement('button');
            tab.className = 'auq-tab' + (idx === 0 ? ' active' : '');
            tab.textContent = q.header || 'Q' + (idx + 1);
            tab.title = q.header || 'Q' + (idx + 1);
            tab.setAttribute('data-tab', idx);
            tab.onclick = function() { switchAuqTab(container, idx); };
            tabHeader.appendChild(tab);
          });

          container.appendChild(tabHeader);
        }

        // Tab content panels
        var tabContent = document.createElement('div');
        tabContent.className = 'auq-tab-content';

        questions.forEach(function(q, idx) {
          var panel = createAuqQuestionPanel(q, idx, container);
          panel.style.display = idx === 0 ? 'block' : 'none';
          tabContent.appendChild(panel);
        });

        container.appendChild(tabContent);

        // Footer with submit button
        var footer = document.createElement('div');
        footer.className = 'auq-footer';

        var skipBtn = document.createElement('button');
        skipBtn.className = 'auq-skip-btn';
        skipBtn.textContent = 'Skip';
        skipBtn.onclick = function() {
          postMessageWithPanelId({
            type: 'askUserQuestionSkipped',
            payload: { toolCallId: toolCallId }
          });
          container.remove();
        };

        var submitBtn = document.createElement('button');
        submitBtn.className = 'auq-submit-btn';
        submitBtn.textContent = 'Submit Answers';
        submitBtn.disabled = true;
        submitBtn.onclick = function() { submitAuqAnswers(container, toolCallId); };

        var submitHint = document.createElement('span');
        submitHint.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: auto; align-self: center;';
        submitHint.textContent = '1-9 to select · Enter to submit';

        footer.appendChild(submitHint);
        footer.appendChild(skipBtn);
        footer.appendChild(submitBtn);
        container.appendChild(footer);

        return container;
      }

      function createAuqQuestionPanel(question, index, container) {
        var panel = document.createElement('div');
        panel.className = 'auq-panel';
        panel.setAttribute('data-panel-index', index);

        // Question text
        var qText = document.createElement('div');
        qText.className = 'auq-question-text';
        qText.textContent = question.question;
        panel.appendChild(qText);

        // Options
        var optionsDiv = document.createElement('div');
        optionsDiv.className = 'auq-options';

        var hasOptions = question.options && question.options.length > 0;
        var inputType = question.multiSelect ? 'checkbox' : 'radio';
        var inputName = 'auq_' + index;

        if (hasOptions) {
          question.options.forEach(function(opt, optIdx) {
            var optionLabel = document.createElement('label');
            optionLabel.className = 'auq-option';
            optionLabel.setAttribute('data-option-num', String(optIdx + 1));

            var input = document.createElement('input');
            input.type = inputType;
            input.name = inputName;
            input.value = opt.label;

            input.onchange = function() {
              handleAuqOptionChange(container, question, index, inputType);
            };

            // Number badge
            var numBadge = document.createElement('span');
            numBadge.className = 'auq-option-number';
            numBadge.textContent = String(optIdx + 1);

            var optContent = document.createElement('div');
            optContent.className = 'auq-option-content';
            optContent.innerHTML =
              '<div class="auq-option-label">' + escapeHtml(opt.label) + '</div>' +
              (opt.description ? '<div class="auq-option-desc">' + escapeHtml(opt.description) + '</div>' : '');

            optionLabel.appendChild(input);
            optionLabel.appendChild(numBadge);
            optionLabel.appendChild(optContent);
            optionsDiv.appendChild(optionLabel);
          });
        }

        // "Other" / free-text option (serves as primary input when no predefined options)
        var otherLabel = document.createElement('label');
        otherLabel.className = 'auq-option auq-option-other';

        var otherInput = document.createElement('input');
        otherInput.type = inputType;
        otherInput.name = inputName;
        otherInput.value = '__other__';
        otherInput.className = 'auq-other-radio';
        if (!hasOptions) {
          otherInput.style.display = 'none';
          otherInput.checked = true;
        }

        var otherContent = document.createElement('div');
        otherContent.className = 'auq-option-content auq-other-content';

        var otherLabelText = document.createElement('div');
        otherLabelText.className = 'auq-option-label';
        otherLabelText.textContent = hasOptions ? 'Other' : 'Your answer';
        otherContent.appendChild(otherLabelText);

        var otherTextInput = document.createElement('input');
        otherTextInput.type = 'text';
        otherTextInput.className = 'auq-other-text';
        otherTextInput.placeholder = 'Type your answer...';

        otherTextInput.onfocus = function() { otherInput.checked = true; };
        otherTextInput.oninput = function() {
          if (otherTextInput.value.trim()) {
            var header = question.header || 'Q' + (index + 1);
            container._answers[header] = otherTextInput.value.trim();
          } else {
            var header = question.header || 'Q' + (index + 1);
            delete container._answers[header];
          }
          updateAuqSubmitButton(container);
          updateAuqTabIndicators(container);
        };

        otherInput.onchange = function() {
          handleAuqOptionChange(container, question, index, inputType);
        };

        otherContent.appendChild(otherTextInput);
        otherLabel.appendChild(otherInput);
        otherLabel.appendChild(otherContent);
        optionsDiv.appendChild(otherLabel);

        panel.appendChild(optionsDiv);
        return panel;
      }

      function handleAuqOptionChange(container, question, index, inputType) {
        var panels = container.querySelectorAll('.auq-panel');
        var panel = panels[index];
        var header = question.header || 'Q' + (index + 1);

        if (inputType === 'checkbox') {
          var inputs = panel.querySelectorAll('input[type="checkbox"]:checked');
          var values = [];

          inputs.forEach(function(i) {
            if (i.value !== '__other__') {
              values.push(i.value);
            }
          });

          var otherRadio = panel.querySelector('.auq-other-radio:checked');
          var otherText = panel.querySelector('.auq-other-text');
          if (otherRadio && otherText && otherText.value.trim()) {
            values.push(otherText.value.trim());
          }

          if (values.length > 0) {
            container._answers[header] = values;
          } else {
            delete container._answers[header];
          }
        } else {
          // Radio - single select
          var checkedInput = panel.querySelector('input[type="radio"]:checked');
          if (checkedInput) {
            if (checkedInput.value === '__other__') {
              var otherText = panel.querySelector('.auq-other-text');
              if (otherText && otherText.value.trim()) {
                container._answers[header] = otherText.value.trim();
              } else {
                delete container._answers[header];
              }
            } else {
              container._answers[header] = checkedInput.value;
              // Auto-advance to next tab for radio buttons
              var tabCount = container.querySelectorAll('.auq-tab').length;
              if (index < tabCount - 1) {
                setTimeout(function() { switchAuqTab(container, index + 1); }, 300);
              }
            }
          }
        }

        updateAuqSubmitButton(container);
        updateAuqTabIndicators(container);
      }

      function switchAuqTab(container, index) {
        var tabs = container.querySelectorAll('.auq-tab');
        var panels = container.querySelectorAll('.auq-panel');

        tabs.forEach(function(t, i) {
          t.classList.toggle('active', i === index);
        });

        panels.forEach(function(p, i) {
          p.style.display = i === index ? 'block' : 'none';
        });

        container._currentTab = index;
      }

      function updateAuqTabIndicators(container) {
        var tabs = container.querySelectorAll('.auq-tab');
        var questions = container._questions;

        tabs.forEach(function(tab, idx) {
          var header = questions[idx].header || 'Q' + (idx + 1);
          var isAnswered = container._answers.hasOwnProperty(header);
          tab.classList.toggle('answered', isAnswered);
        });
      }

      function updateAuqSubmitButton(container) {
        var submitBtn = container.querySelector('.auq-submit-btn');
        var questions = container._questions;
        var answeredCount = 0;

        questions.forEach(function(q, idx) {
          var header = q.header || 'Q' + (idx + 1);
          if (container._answers.hasOwnProperty(header)) {
            answeredCount++;
          }
        });

        submitBtn.disabled = answeredCount < questions.length;
      }

      function submitAuqAnswers(container, toolCallId) {
        // Visual feedback
        container.classList.add('submitted');

        // Send answers to extension
        postMessageWithPanelId({
          type: 'askUserQuestionResponse',
          payload: {
            toolCallId: toolCallId,
            answers: container._answers
          }
        });

        // Replace with confirmation
        container.innerHTML = '<div class="auq-submitted"><span class="auq-check">✓</span> Answers submitted</div>';

        setTimeout(function() { container.remove(); }, 1500);
      }

      // Single owner of the "is a request in flight" UI: swaps send⇄stop, the
      // disabled state, and the quick-actions visibility. Called IMMEDIATELY on
      // send (so Stop is available during the pre-first-token window), and on
      // every terminal path (complete/error/cancel). Idempotent.
      function setProcessing(on) {
        state.isLoading = on;
        if (sendBtn) { sendBtn.style.display = on ? 'none' : 'flex'; sendBtn.disabled = on; }
        if (stopBtn) { stopBtn.style.display = on ? 'flex' : 'none'; }
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) { quickActionsContainer.classList.toggle('ai-running', on); }
        if (!on) {
          currentResponse = '';
          currentThinking = '';
          contentSegmentIndex = 0;
        }
      }

      function showLoading() {
        setProcessing(true);
        // The bottom "thinking" spinner is appended on responseStarted (after the
        // user bubble is rendered) so it stays at the end of the transcript.
        // Idempotent — never stack two.
        if (!messagesEl.querySelector('.loading')) {
          var loading = document.createElement('div');
          loading.className = 'loading';
          loading.innerHTML = '<div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>';
          messagesEl.appendChild(loading);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }

      function hideLoading() {
        setProcessing(false);
        var loading = messagesEl.querySelector('.loading');
        if (loading) loading.remove();
      }

      // Dynamic suggestions functions (ezorro-style cards)
      function showSuggestionSkeleton() {
        var container = document.getElementById('quick-actions');
        if (!container) return;

        // Don't show if suggestions are disabled
        if (state.agentSettings && !state.agentSettings.showSuggestions) {
          container.innerHTML = '';
          return;
        }

        container.classList.add('loading');
        container.innerHTML = '';

        for (var i = 0; i < 6; i++) {
          var card = document.createElement('div');
          card.className = 'skeleton-card';
          card.style.animationDelay = (i * 0.1) + 's';
          card.innerHTML =
            '<div class="skeleton-icon"></div>' +
            '<div class="skeleton-content">' +
              '<div class="skeleton-text" style="width: 60%;"></div>' +
              '<div class="skeleton-text" style="width: 90%;"></div>' +
            '</div>';
          container.appendChild(card);
        }
      }

      function renderSuggestions(suggestions) {
        var container = document.getElementById('quick-actions');
        if (!container) return;

        // Don't render if suggestions are disabled
        if (state.agentSettings && !state.agentSettings.showSuggestions) {
          container.innerHTML = '';
          return;
        }

        container.classList.remove('loading');
        container.innerHTML = '';

        suggestions.forEach(function(s, i) {
          var card = document.createElement('button');
          card.className = 'suggestion-card';
          card.setAttribute('data-color', s.color || 'blue');
          card.style.animationDelay = (i * 0.06) + 's';
          card.title = s.description || s.message;

          card.innerHTML =
            '<span class="suggestion-icon">' + (s.icon || '💡') + '</span>' +
            '<span class="suggestion-title">' + escapeHtml(s.title) + '</span>';

          card.onclick = function() {
            postMessageWithPanelId({ type: 'executeSuggestion', payload: s });
          };

          container.appendChild(card);
        });
      }

      // ======================================================================
      // Per-message attribution + footer (Plan 02 Phase 3.4)
      // ======================================================================

      // Message.thinking is a plain string in legacy conversations and
      // { style, content } from Plan 02 Phase 3 onwards — normalize to the
      // object shape. Legacy strings replay as one complete block.
      function normalizeMessageThinking(thinking) {
        if (!thinking) return null;
        if (typeof thinking === 'string') {
          return thinking.trim() ? { style: 'complete-blocks', content: thinking } : null;
        }
        if (!thinking.content) return null;
        return {
          style: thinking.style === 'streamed' ? 'streamed' : 'complete-blocks',
          content: thinking.content
        };
      }

      // Attribution for a message: the PERSISTED per-message provider/model
      // stamp wins; legacy messages fall back to the conversation's
      // provider/model, then to the live settings (fixes stale model chips
      // after switching providers).
      function getMessageAttribution(msg) {
        var conv = state.conversation || {};
        return {
          provider: (msg && msg.provider) || conv.provider || (state.settings && state.settings.provider) || null,
          model: (msg && msg.model) || conv.model || (state.settings && state.settings.model) || ''
        };
      }

      // Update an existing message header's model chip from the message's
      // persisted attribution (live path: called at finalize, when the
      // persisted message — including any @-mention provider switch — is
      // known).
      function updateMessageAttributionChip(messageEl, msg) {
        if (!messageEl) return;
        var chip = messageEl.querySelector('.message-model-info');
        if (!chip) return;
        var attribution = getMessageAttribution(msg);
        var entry = getManifestEntry(attribution.provider);
        chip.textContent = getModelDisplayName(attribution.model);
        chip.title = entry ? 'Generated by ' + entry.displayName : '';
      }

      // Tool cards auto-resolve when the provider never streams tool_result
      // (manifest emitsToolResults === false: the provider emits tool_use
      // only). Unknown providers / missing manifest -> false (leave cards to
      // the stream).
      function shouldAutoResolveToolCards(providerId) {
        var entry = getManifestEntry(providerId);
        if (!entry || !entry.capabilities) return false;
        return entry.capabilities.emitsToolResults === false;
      }

      // Mark still-running/pending tool cards inside a finished message as
      // completed with a "not reported" note — never an eternal spinner.
      function autoResolveRunningToolCards(messageEl) {
        if (!messageEl) return;
        var cards = messageEl.querySelectorAll('.tool-call.running, .tool-call.pending');
        cards.forEach(function(card) {
          card.classList.remove('running');
          card.classList.remove('pending');
          card.classList.add('completed');
          var statusEl = card.querySelector('.tool-call-status');
          if (statusEl) {
            statusEl.className = 'tool-call-status completed';
            statusEl.textContent = 'completed';
            statusEl.title = 'This agent does not report tool results';
          }
          var header = card.querySelector('.tool-call-header');
          if (header && !card.querySelector('.tool-call-note')) {
            var note = document.createElement('span');
            note.className = 'tool-call-note';
            note.textContent = 'result not reported';
            note.title = 'This agent does not report tool results';
            var statusRef = header.querySelector('.tool-call-status');
            if (statusRef) {
              header.insertBefore(note, statusRef);
            } else {
              header.appendChild(note);
            }
          }
        });
      }

      // ONE message footer used by live done handling AND restored
      // messages. usage: { input_tokens, output_tokens, ... } | null.
      // sessionInfo: { provider, model, sessionId? } | null — provider
      // drives the emitsToolResults auto-resolve. degradationPills:
      // string[] rendered verbatim (Phase 4 computes the real pills).
      function renderMessageFooter(messageEl, usage, sessionInfo, degradationPills) {
        if (!messageEl) return null;

        var providerId = sessionInfo && sessionInfo.provider;
        if (shouldAutoResolveToolCards(providerId)) {
          autoResolveRunningToolCards(messageEl);
        }

        var existing = messageEl.querySelector('.message-footer');
        if (existing) existing.remove();

        var parts = [];
        if (usage && (usage.input_tokens || usage.output_tokens)) {
          parts.push('<span class="message-footer-item message-footer-tokens" title="Tokens in / out">' +
            (usage.input_tokens || 0) + ' in \u00b7 ' + (usage.output_tokens || 0) + ' out</span>');
        }
        if (sessionInfo && sessionInfo.sessionId) {
          var shortSession = String(sessionInfo.sessionId).substring(0, 8);
          parts.push('<span class="message-footer-item message-footer-session" title="Session ' + escapeHtml(String(sessionInfo.sessionId)) + '">session ' + escapeHtml(shortSession) + '</span>');
        }
        (degradationPills || []).forEach(function(pill) {
          parts.push('<span class="message-footer-pill">' + escapeHtml(pill) + '</span>');
        });

        if (parts.length === 0) return null;

        var footer = document.createElement('div');
        footer.className = 'message-footer';
        footer.innerHTML = parts.join('');
        messageEl.appendChild(footer);
        return footer;
      }

      function finalizeStreamingMessage(msg) {
        var streamingEl = messagesEl.querySelector('.message.streaming:not([data-brainstorm-synthesis])');
        if (streamingEl) {
          // Remove streaming class from thinking block
          var streamingThinking = streamingEl.querySelector('.thinking-block.streaming-thinking');
          if (streamingThinking) {
            streamingThinking.classList.remove('streaming-thinking');
          }

          streamingEl.classList.remove('streaming');
          streamingEl.dataset.id = msg.id;

          // Per-message attribution chip from the persisted provider/model
          // (post-@-mention-switch values, not the dropdown selection)
          updateMessageAttributionChip(streamingEl, msg);

          // Re-render all content segments with final markdown
          var messageBody = streamingEl.querySelector('.message-body');
          if (messageBody && msg.content) {
            var segments = messageBody.querySelectorAll('.message-content');
            if (segments.length === 1) {
              // Single segment - render full content
              segments[0].innerHTML = formatContent(msg.content);
            }
            // For multiple segments, leave them as-is (already rendered during streaming)
          }
        }
        return streamingEl;
      }

      function showError(error) {
        var div = document.createElement('div');
        div.className = 'message error';
        div.innerHTML = '<div class="message-content" style="color: var(--vscode-errorForeground);">Error: ' + escapeHtml(error) + '</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function showAuthError(data) {
        var div = document.createElement('div');
        div.className = 'message error auth-error';
        div.innerHTML = '<div class="message-content">' +
          '<div style="color: var(--vscode-errorForeground); margin-bottom: 8px;">' +
            '<strong>Authentication Required</strong>' +
          '</div>' +
          '<p style="margin: 8px 0;">' + escapeHtml(data.providerName) + ' is not authenticated.</p>' +
          '<div style="margin: 12px 0; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-family: monospace;">' +
            '<strong>To authenticate, run:</strong><br>' +
            '<code style="color: var(--vscode-textPreformat-foreground);">' + escapeHtml(data.authCommand) + '</code>' +
          '</div>' +
          '<button id="auth-terminal-btn" ' +
            'style="padding: 6px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px;">' +
            'Open Terminal & Authenticate' +
          '</button>' +
        '</div>';
        messagesEl.appendChild(div);

        // Add event listener (CSP compliant - no inline onclick)
        var authBtn = div.querySelector('#auth-terminal-btn');
        if (authBtn) {
          authBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openTerminal', payload: data.authCommand });
          });
        }

        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function clearMessages() {
        messagesEl.innerHTML = '<div class="welcome-container"><div class="welcome-header"><img src="' + LOGO_URI + '" alt="Mysti" class="welcome-logo" /><h2>Welcome to Mysti</h2><p>Your AI coding team. Choose an action or ask anything!</p></div><div class="welcome-suggestions" id="welcome-suggestions"></div><div class="welcome-spread"><h3>Spread the Word</h3><div class="about-links spread-links"><a href="https://github.com/DeepMyst/Mysti" target="_blank" rel="noopener" class="spread-link"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg> Star on GitHub</a><a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti&ssr=false#review-details" target="_blank" rel="noopener" class="spread-link"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.399l-.254.008.045-.236 2.101-.574.028.166-.978 4.607z"/><circle cx="8" cy="4.5" r="1"/></svg> Rate on Marketplace</a><a id="share-on-x" href="#" class="spread-link" title="Share on X / Twitter"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> Share on X</a></div></div></div>';
        renderWelcomeSuggestions();
        // Reset all streaming buffers
        currentResponse = '';
        currentThinking = '';
        contentSegmentIndex = 0;
      }

      function updateContext(context) {
        state.context = context;
        if (!contextItems) return;

        if (context.length === 0) {
          contextItems.innerHTML = '<div class="context-empty">Drop files here or click + to add context</div>';
          return;
        }

        contextItems.innerHTML = context.map(function(item) {
          return '<div class="context-item" data-id="' + item.id + '"><span class="context-item-path" title="' + item.path + '">' + getFileName(item.path) + (item.type === 'selection' ? ' (selection)' : '') + '</span><button class="context-item-remove" data-id="' + item.id + '">x</button></div>';
        }).join('');

        contextItems.querySelectorAll('.context-item-remove').forEach(function(btn) {
          btn.addEventListener('click', function() {
            postMessageWithPanelId({ type: 'removeFromContext', payload: btn.dataset.id });
          });
        });
      }

      // Plan 06: a single Mode axis replaces Mode × Access × Autonomy. Each mode
      // maps to the existing engine settings (mode/accessLevel/autonomyLevel);
      // deriveChatMode reverses the current settings back to one of these.
      var CHAT_MODES = [
        { id: 'plan',        label: 'Plan',        mode: 'detailed-plan',      access: 'read-only',      autonomy: 'manual',     desc: 'Read-only — proposes a plan, makes no changes' },
        { id: 'ask',         label: 'Ask',         mode: 'ask-before-edit',    access: 'ask-permission', autonomy: 'manual',     desc: 'Asks before every edit & command' },
        { id: 'auto-edit',   label: 'Auto-edit',   mode: 'edit-automatically', access: 'ask-permission', autonomy: 'manual',     desc: 'Auto-applies edits; asks before commands' },
        { id: 'full-access', label: 'Full access', mode: 'edit-automatically', access: 'full-access',     autonomy: 'manual',     desc: 'Edits & runs commands without asking' },
        { id: 'autonomous',  label: 'Autonomous',  mode: 'edit-automatically', access: 'full-access',     autonomy: 'autonomous', desc: 'Full access + keeps working on its own' }
      ];
      function chatModeById(id) {
        for (var i = 0; i < CHAT_MODES.length; i++) { if (CHAT_MODES[i].id === id) return CHAT_MODES[i]; }
        return null;
      }
      function deriveChatMode() {
        if (state.autonomyLevel === 'autonomous') return 'autonomous';
        var m = state.settings.mode, a = state.settings.accessLevel;
        if (a === 'read-only' || m === 'quick-plan' || m === 'detailed-plan') return 'plan';
        if (m === 'edit-automatically' && a === 'full-access') return 'full-access';
        if (m === 'edit-automatically') return 'auto-edit';
        return 'ask';
      }
      function applyChatMode(id) {
        var def = chatModeById(id);
        if (!def) return;
        state.settings.mode = def.mode;
        state.settings.accessLevel = def.access;
        // Persist mode + access via the same message the old dropdowns used.
        postMessageWithPanelId({ type: 'updateSettings', payload: { mode: def.mode, accessLevel: def.access } });
        // Autonomy keeps its own activation path (AutonomousManager).
        if (typeof setAutonomyLevel === 'function') { setAutonomyLevel(def.autonomy); }
        updateBehaviorIndicator();
        updateBehaviorHint();
        renderModeOptions();
      }
      function renderModeOptions() {
        var active = deriveChatMode();
        var opts = document.querySelectorAll('#behavior-popup .mode-option');
        for (var i = 0; i < opts.length; i++) {
          opts[i].classList.toggle('active', opts[i].getAttribute('data-mode') === active);
        }
      }

      function updateBehaviorIndicator() {
        if (!behaviorIndicator) return;
        var id = deriveChatMode();
        var def = chatModeById(id);
        behaviorIndicator.classList.remove('autonomous-active', 'semi-auto-active');
        if (id === 'autonomous') {
          behaviorIndicator.innerHTML = '<span class="behavior-dot"></span>' + (def ? def.label : 'Autonomous');
          behaviorIndicator.classList.add('autonomous-active');
        } else {
          behaviorIndicator.textContent = def ? def.label : 'Ask';
        }
      }

      function updateBehaviorHint() {
        var hint = document.getElementById('behavior-hint');
        if (!hint) return;
        var def = chatModeById(deriveChatMode());
        hint.textContent = def ? def.desc : '';
      }

      /**
       * Update the agent settings UI from state
       */
      function updateAgentSettingsUI() {
        var autoSuggestToggle = document.getElementById('auto-suggest-toggle');
        var tokenLimitToggle = document.getElementById('token-limit-toggle');
        var tokenBudgetInput = document.getElementById('token-budget-input');
        var tokenBudgetSection = document.getElementById('token-budget-section');

        if (autoSuggestToggle) {
          if (state.agentSettings.autoSuggest) {
            autoSuggestToggle.classList.add('active');
          } else {
            autoSuggestToggle.classList.remove('active');
          }
        }

        // Token limit is enabled when maxTokenBudget > 0
        var tokenLimitEnabled = state.agentSettings.maxTokenBudget > 0;
        state.agentSettings.tokenLimitEnabled = tokenLimitEnabled;

        if (tokenLimitToggle) {
          if (tokenLimitEnabled) {
            tokenLimitToggle.classList.add('active');
          } else {
            tokenLimitToggle.classList.remove('active');
          }
        }

        if (tokenBudgetSection) {
          if (tokenLimitEnabled) {
            tokenBudgetSection.classList.remove('hidden');
          } else {
            tokenBudgetSection.classList.add('hidden');
          }
        }

        if (tokenBudgetInput && tokenLimitEnabled) {
          tokenBudgetInput.value = String(state.agentSettings.maxTokenBudget);
        }

        // Suggestions toggle
        var suggestionsToggle = document.getElementById('suggestions-toggle');
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (suggestionsToggle) {
          if (state.agentSettings.showSuggestions) {
            suggestionsToggle.classList.add('active');
          } else {
            suggestionsToggle.classList.remove('active');
          }
        }
        if (quickActionsContainer) {
          if (state.agentSettings.showSuggestions) {
            quickActionsContainer.classList.remove('hidden');
          } else {
            quickActionsContainer.classList.add('hidden');
          }
        }
      }

      /**
       * Update the context usage pie chart
       * @param usedTokens - Number of tokens used (input_tokens from response)
       * @param contextWindow - Context window size (null to keep existing)
       */
      function updateContextUsage(usedTokens, contextWindow) {
        if (contextWindow !== null && contextWindow !== undefined) {
          state.contextUsage.contextWindow = contextWindow;
        }
        state.contextUsage.usedTokens = usedTokens || 0;

        var percentage = Math.min(100, Math.round((state.contextUsage.usedTokens / state.contextUsage.contextWindow) * 100));
        state.contextUsage.percentage = percentage;

        var pieFill = document.getElementById('context-pie-fill');
        var usageText = document.getElementById('context-usage-text');
        var usageContainer = document.getElementById('context-usage');

        if (pieFill && usageText && usageContainer) {
          // Calculate pie slice path
          // Center at (16,16), radius 14, starting from top (12 o'clock)
          var cx = 16, cy = 16, r = 14;
          if (percentage <= 0) {
            pieFill.setAttribute('d', '');
          } else if (percentage >= 100) {
            // Full circle
            pieFill.setAttribute('d', 'M ' + cx + ' ' + (cy - r) + ' A ' + r + ' ' + r + ' 0 1 1 ' + (cx - 0.001) + ' ' + (cy - r) + ' Z');
          } else {
            // Calculate end point of arc
            var angle = (percentage / 100) * 2 * Math.PI;
            var endX = cx + r * Math.sin(angle);
            var endY = cy - r * Math.cos(angle);
            var largeArc = percentage > 50 ? 1 : 0;
            // Path: Move to center, line to top, arc to end point, close
            var d = 'M ' + cx + ' ' + cy + ' L ' + cx + ' ' + (cy - r) + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + endX + ' ' + endY + ' Z';
            pieFill.setAttribute('d', d);
          }

          // Update percentage text
          usageText.textContent = percentage + '%';

          // Update tooltip
          var usedK = Math.round(state.contextUsage.usedTokens / 1000);
          var totalK = Math.round(state.contextUsage.contextWindow / 1000);
          usageContainer.title = 'Context usage: ' + usedK + 'k / ' + totalK + 'k tokens (' + percentage + '%) — Click to compact';

          // Update color based on usage level
          usageContainer.classList.remove('warning', 'danger', 'threshold-warning');
          if (percentage >= 90) {
            usageContainer.classList.add('danger');
          } else if (percentage >= 75) {
            usageContainer.classList.add('threshold-warning');
          } else if (percentage >= 70) {
            usageContainer.classList.add('warning');
          }
        }
      }

      /**
       * Reset context usage (for new conversations)
       */
      function resetContextUsage() {
        state.contextUsage.usedTokens = 0;
        state.contextUsage.percentage = 0;
        updateContextUsage(0, null);
      }

      /**
       * Handle compaction status events from the extension
       */
      function handleCompactionStatus(event) {
        var usageContainer = document.getElementById('context-usage');
        var statusEl = document.getElementById('compaction-status');

        if (!statusEl) {
          statusEl = document.createElement('div');
          statusEl.id = 'compaction-status';
          statusEl.className = 'compaction-status hidden';
          if (usageContainer && usageContainer.parentNode) {
            usageContainer.parentNode.insertBefore(statusEl, usageContainer.nextSibling);
          }
        }

        switch (event.status) {
          case 'compacting':
            if (usageContainer) { usageContainer.classList.add('compacting'); }
            statusEl.innerHTML = '<span class="compaction-spinner"></span> Compacting...';
            statusEl.classList.remove('hidden');
            statusEl.title = event.strategy === 'native-cli'
              ? 'Running /compact via CLI'
              : 'Summarizing older messages';
            break;

          case 'complete':
            if (usageContainer) { usageContainer.classList.remove('compacting'); }
            statusEl.textContent = 'Compacted';
            statusEl.classList.remove('hidden');

            if (event.afterTokens !== undefined && event.afterTokens > 0) {
              updateContextUsage(event.afterTokens, event.contextWindow);
            } else {
              // Native CLI /compact doesn't return post-compaction tokens;
              // reset pie chart — next response will show actual usage
              updateContextUsage(0, event.contextWindow);
            }

            // Show compaction result in chat
            if (event.summary) {
              addSystemMessage(event.summary);
            } else {
              addSystemMessage('Conversation compacted');
            }

            setTimeout(function() {
              statusEl.classList.add('hidden');
            }, 5000);
            break;

          case 'error':
            if (usageContainer) { usageContainer.classList.remove('compacting'); }
            statusEl.textContent = 'Compaction failed';
            statusEl.title = event.error || 'Unknown error';
            statusEl.classList.remove('hidden');
            addSystemMessage('Compaction failed: ' + (event.error || 'Unknown error'));
            setTimeout(function() {
              statusEl.classList.add('hidden');
            }, 5000);
            break;

          default:
            if (usageContainer) { usageContainer.classList.remove('compacting'); }
            statusEl.classList.add('hidden');
        }
      }

      function showSlashMenu(query) {
        state.slashMenuQuery = query || '';
        state.slashMenuIndex = 0;
        state.slashMenuVisible = true;

        // Request commands from extension (resolves dynamic values per panel)
        postMessageWithPanelId({
          type: 'requestSlashCommands',
          payload: { query: state.slashMenuQuery }
        });
      }

      function hideSlashMenu() {
        var menu = document.getElementById('slash-menu');
        if (menu) menu.classList.add('hidden');
        state.slashMenuVisible = false;
        state.slashMenuQuery = '';
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
      }

      function renderSlashMenu(data) {
        var menu = document.getElementById('slash-menu');
        var sectionsEl = document.getElementById('slash-menu-sections');
        var emptyEl = document.getElementById('slash-menu-empty');
        var queryEl = document.getElementById('slash-menu-query');
        if (!menu || !sectionsEl) return;

        // Update search display
        if (queryEl) queryEl.textContent = state.slashMenuQuery;

        // Filter commands by query
        var query = (state.slashMenuQuery || '').toLowerCase();
        var filteredCmds = data.commands;
        if (query) {
          filteredCmds = data.commands.filter(function(cmd) {
            var searchText = (cmd.label + ' ' + cmd.description + ' ' + (cmd.keywords || []).join(' ')).toLowerCase();
            // Simple substring match — fuzzy not needed since extension also filters
            return searchText.indexOf(query) !== -1;
          });
        }

        // Group by section, maintaining section order
        var grouped = {};
        filteredCmds.forEach(function(cmd) {
          if (!grouped[cmd.section]) grouped[cmd.section] = [];
          grouped[cmd.section].push(cmd);
        });

        // Build HTML
        var html = '';
        var flatItems = [];
        var sortedSections = data.sections.slice().sort(function(a, b) {
          return a.order - b.order;
        });

        sortedSections.forEach(function(section) {
          var cmds = grouped[section.id];
          if (!cmds || cmds.length === 0) return;

          html += '<div class="slash-menu-section-header">' + escapeHtml(section.label) + '</div>';

          cmds.forEach(function(cmd) {
            var globalIdx = flatItems.length;
            var selectedClass = globalIdx === state.slashMenuIndex ? ' selected' : '';

            var iconHtml = cmd.icon
              ? '<span class="slash-menu-item-icon codicon codicon-' + cmd.icon + '"></span>'
              : '<span class="slash-menu-item-icon"></span>';

            var rightHtml = '';
            if (cmd.isToggle) {
              rightHtml = '<span class="slash-menu-item-toggle' + (cmd.toggleState ? ' active' : '') + '"></span>';
            } else if (cmd.currentValue) {
              rightHtml = '<span class="slash-menu-item-value">' + escapeHtml(cmd.currentValue) + '</span>';
            }

            html += '<div class="slash-menu-item' + selectedClass
              + '" data-index="' + globalIdx
              + '" data-command-id="' + cmd.id
              + '" role="option">'
              + iconHtml
              + '<span class="slash-menu-item-content">'
              + '<span class="slash-menu-item-label">' + escapeHtml(cmd.label) + '</span>'
              + '<span class="slash-menu-item-description">' + escapeHtml(cmd.description) + '</span>'
              + '</span>'
              + rightHtml
              + '</div>';

            flatItems.push(cmd);
          });
        });

        state.slashMenuItems = flatItems;

        if (flatItems.length === 0) {
          sectionsEl.innerHTML = '';
          if (emptyEl) emptyEl.classList.remove('hidden');
        } else {
          if (emptyEl) emptyEl.classList.add('hidden');
          sectionsEl.innerHTML = html;
        }

        // Position above input area
        var inputArea = document.querySelector('.input-area');
        if (inputArea) {
          var rect = inputArea.getBoundingClientRect();
          menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        }

        menu.classList.remove('hidden');

        // Attach click handlers via event delegation
        sectionsEl.onclick = function(e) {
          var item = e.target.closest('.slash-menu-item');
          if (item) {
            var idx = parseInt(item.dataset.index, 10);
            if (state.slashMenuItems[idx]) {
              executeSlashMenuItem(state.slashMenuItems[idx]);
            }
          }
        };
      }

      function executeSlashMenuItem(cmd) {
        hideSlashMenu();
        var inputEl = document.getElementById('message-input');
        if (inputEl) {
          inputEl.value = '';
          inputEl.style.height = 'auto';
        }

        if (cmd.action === 'external' && cmd.url) {
          postMessageWithPanelId({ type: 'openExternal', payload: { url: cmd.url } });
          return;
        }

        // Execute command via extension
        postMessageWithPanelId({
          type: 'executeSlashCommand',
          payload: {
            commandId: cmd.id,
            args: ''
          }
        });
      }

      function updateSlashMenuSelection() {
        var sectionsEl = document.getElementById('slash-menu-sections');
        if (!sectionsEl) return;
        var items = sectionsEl.querySelectorAll('.slash-menu-item');
        items.forEach(function(el) {
          var idx = parseInt(el.dataset.index, 10);
          if (idx === state.slashMenuIndex) {
            el.classList.add('selected');
            el.scrollIntoView({ block: 'nearest' });
          } else {
            el.classList.remove('selected');
          }
        });
      }

      // Autocomplete helper functions
      function updateGhostText(suggestion) {
        if (!autocompleteGhostEl || !suggestion) {
          clearAutocomplete();
          return;
        }
        // Show the current text plus the suggested completion in ghost style
        var currentText = inputEl.value;
        // Create ghost content: invisible current text + visible suggestion
        var invisiblePart = '<span style="visibility: hidden;">' + escapeHtml(currentText) + '</span>';
        var ghostPart = '<span class="ghost-text">' + escapeHtml(suggestion) + '</span>';
        autocompleteGhostEl.innerHTML = invisiblePart + ghostPart;
        state.autocompleteSuggestion = suggestion;
      }

      function clearAutocomplete() {
        if (autocompleteGhostEl) {
          autocompleteGhostEl.innerHTML = '';
        }
        state.autocompleteSuggestion = null;
        state.autocompleteType = null;
        // Cancel any pending autocomplete request
        postMessageWithPanelId({ type: 'cancelAutocomplete' });
      }

      function acceptAutocomplete() {
        if (state.autocompleteSuggestion) {
          // Append the suggestion to the input
          inputEl.value = inputEl.value + state.autocompleteSuggestion;
          // Update textarea height
          autoResizeTextarea();
          // Clear the ghost text
          clearAutocomplete();
          // Focus at the end
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
      }

      // Auto-resize textarea to fit content up to 10 lines (240px max)
      function autoResizeTextarea() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + 'px';
      }

      function getFileName(path) {
        return path.split(/[\\/]/).pop();
      }

      function getModelDisplayName(modelId) {
        if (state.providers) {
          for (var i = 0; i < state.providers.length; i++) {
            var provider = state.providers[i];
            for (var j = 0; j < provider.models.length; j++) {
              if (provider.models[j].id === modelId) {
                return provider.models[j].name;
              }
            }
          }
        }
        // Fallback: format model ID nicely
        return modelId.replace(/-/g, ' ').replace(/\d{8}$/, '').trim();
      }

      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // ========================================
      // Edit Report Card Functions
      // ========================================

      var FILE_EDIT_TOOLS = ['write', 'edit', 'multiwrite', 'notebookedit'];

      function isFileEditTool(toolName) {
        return FILE_EDIT_TOOLS.includes((toolName || '').toLowerCase());
      }

      // Helper to split content into lines (handles various newline formats)
      function splitLines(str) {
        if (!str) return [];
        // Handle both actual newlines and escaped \n sequences
        return String(str).split(/\r?\n|\\n/);
      }

      // GitHub-style diff: identify context lines (unchanged) vs actual changes
      function computeLineDiff(oldLines, newLines) {
        var result = [];

        // Find common prefix (unchanged lines at start)
        var prefixLen = 0;
        while (prefixLen < oldLines.length && prefixLen < newLines.length
               && oldLines[prefixLen] === newLines[prefixLen]) {
          prefixLen++;
        }

        // Find common suffix (unchanged lines at end)
        var suffixLen = 0;
        while (suffixLen < (oldLines.length - prefixLen)
               && suffixLen < (newLines.length - prefixLen)
               && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
          suffixLen++;
        }

        // Add context lines from prefix (5 lines before changes)
        var contextBefore = Math.min(prefixLen, 5);
        for (var i = prefixLen - contextBefore; i < prefixLen; i++) {
          result.push({ type: 'context', content: oldLines[i], lineNum: i + 1 });
        }

        // Add deletions (lines only in old)
        for (var i = prefixLen; i < oldLines.length - suffixLen; i++) {
          result.push({ type: 'deletion', content: oldLines[i], lineNum: i + 1 });
        }

        // Add additions (lines only in new)
        for (var i = prefixLen; i < newLines.length - suffixLen; i++) {
          result.push({ type: 'addition', content: newLines[i], lineNum: i + 1 });
        }

        // Add context lines from suffix (5 lines after changes)
        var contextAfter = Math.min(suffixLen, 5);
        var suffixStart = newLines.length - suffixLen;
        for (var i = suffixStart; i < suffixStart + contextAfter; i++) {
          result.push({ type: 'context', content: newLines[i], lineNum: i + 1 });
        }

        return result;
      }

      // Detect programming language from file extension for syntax highlighting
      function getLanguageFromPath(filePath) {
        var ext = (filePath || '').split('.').pop().toLowerCase();
        var langMap = {
          'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript',
          'ts': 'typescript', 'tsx': 'typescript',
          'py': 'python',
          'go': 'go',
          'css': 'css', 'scss': 'scss',
          'html': 'html', 'htm': 'html',
          'json': 'json',
          'md': 'markdown',
          'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
          'xml': 'xml', 'svg': 'xml',
          'yaml': 'yaml', 'yml': 'yaml',
          'rs': 'rust',
          'rb': 'ruby',
          'php': 'php',
          'java': 'java',
          'c': 'c', 'h': 'c',
          'cpp': 'cpp', 'cc': 'cpp', 'hpp': 'cpp',
          'cs': 'csharp',
          'swift': 'swift',
          'kt': 'kotlin',
          'sql': 'sql'
        };
        return langMap[ext] || 'javascript';
      }

      // Highlight code content using Prism.js if available
      function highlightCode(content, language) {
        if (typeof Prism !== 'undefined' && Prism.languages && Prism.languages[language]) {
          try {
            return Prism.highlight(content, Prism.languages[language], language);
          } catch (e) {
            return escapeHtml(content);
          }
        }
        return escapeHtml(content);
      }

      function parseFileEditInfo(toolName, input, output) {
        var info = {
          action: 'edit',
          filePath: '',
          fileName: '',
          linesAdded: 0,
          linesRemoved: 0,
          diffLines: []
        };

        // Extract file path (convert to relative for display)
        var absolutePath = input.file_path || input.path || input.notebook_path || '';
        info.filePath = makeRelativePath(absolutePath);
        if (info.filePath) {
          var parts = info.filePath.replace(/\\/g, '/').split('/');
          info.fileName = parts.pop() || info.filePath;
        }

        var toolLower = (toolName || '').toLowerCase();

        // Determine action type based on tool and content
        if (toolLower === 'write') {
          // Write tool creates or overwrites a file
          info.action = 'create';

          // For Write, entire content is new
          if (input.content) {
            var lines = splitLines(input.content);
            info.linesAdded = lines.length;
            info.diffLines = lines.map(function(line, idx) {
              return { type: 'addition', content: line, lineNum: idx + 1 };
            });
          }
        } else if (toolLower === 'edit') {
          info.action = 'edit';

          // Edit tool has old_string and new_string
          var oldStr = input.old_string || '';
          var newStr = input.new_string || '';

          var oldLines = splitLines(oldStr);
          var newLines = splitLines(newStr);

          // Filter out empty lines that result from empty strings
          if (oldLines.length === 1 && oldLines[0] === '') oldLines = [];
          if (newLines.length === 1 && newLines[0] === '') newLines = [];

          // Use GitHub-style diff algorithm to identify context vs changes
          info.diffLines = computeLineDiff(oldLines, newLines);

          // Count actual additions and deletions (not context lines)
          info.linesAdded = info.diffLines.filter(function(l) { return l.type === 'addition'; }).length;
          info.linesRemoved = info.diffLines.filter(function(l) { return l.type === 'deletion'; }).length;
        } else if (toolLower === 'multiwrite') {
          info.action = 'create';
          // MultiWrite may have multiple files - just show stats
          if (input.content) {
            var lines = splitLines(input.content);
            info.linesAdded = lines.length;
          }
        } else if (toolLower === 'notebookedit') {
          info.action = 'edit';
          if (input.new_source) {
            var lines = splitLines(input.new_source);
            info.linesAdded = lines.length;
            info.diffLines = lines.map(function(line, idx) {
              return { type: 'addition', content: line, lineNum: idx + 1 };
            });
          }
        }

        return info;
      }

      // Generate unique ID from todo content
      function generateTodoId(content) {
        var hash = 0;
        for (var i = 0; i < content.length; i++) {
          hash = ((hash << 5) - hash) + content.charCodeAt(i);
          hash |= 0;
        }
        return 'todo-' + Math.abs(hash);
      }

      // Update sticky progress count display
      function updateStickyProgressCount() {
        var container = document.getElementById('sticky-progress-container');
        if (!container) return;
        var countEl = container.querySelector('.sticky-progress-count');
        if (countEl) {
          countEl.textContent = stuckTodos.size + ' in progress';
        }
      }

      // Stick a todo item to the top
      function stickTodoItem(originalEl, todoId) {
        if (stuckTodos.has(todoId)) return; // Already stuck

        var container = document.getElementById('sticky-progress-container');
        if (!container) return;
        var listEl = container.querySelector('.sticky-progress-list');
        if (!listEl) return;

        // Mark original as stuck
        originalEl.classList.add('is-stuck');

        // Get the display text (activeForm if available)
        var todoContent = originalEl.getAttribute('data-todo-content') || '';
        var activeForm = originalEl.getAttribute('data-todo-active-form') || todoContent;

        // Create clone for sticky container
        var spinnerSvg = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8"/></svg>';

        var cloneEl = document.createElement('div');
        cloneEl.className = 'stuck-todo-item';
        cloneEl.setAttribute('data-todo-id', todoId);
        cloneEl.innerHTML =
          '<span class="stuck-todo-icon">' + spinnerSvg + '</span>' +
          '<span class="stuck-todo-text">' + escapeHtml(activeForm) + '</span>';

        listEl.appendChild(cloneEl);

        // Show container
        container.classList.add('has-items');
        updateStickyProgressCount();

        // Track stuck item
        stuckTodos.set(todoId, { originalEl: originalEl, cloneEl: cloneEl });
      }

      // Unstick a todo item (animate it back)
      function unstickTodoItem(todoId) {
        var stuckItem = stuckTodos.get(todoId);
        if (!stuckItem) return;

        var cloneEl = stuckItem.cloneEl;
        var originalEl = stuckItem.originalEl;

        // Animate out
        cloneEl.classList.add('unsticking');

        cloneEl.addEventListener('animationend', function() {
          // Remove clone
          if (cloneEl.parentNode) {
            cloneEl.parentNode.removeChild(cloneEl);
          }

          // Restore original visibility
          originalEl.classList.remove('is-stuck');

          // Clean up tracking
          stuckTodos.delete(todoId);

          // Hide container if empty
          var container = document.getElementById('sticky-progress-container');
          if (container && stuckTodos.size === 0) {
            container.classList.remove('has-items');
          }
          updateStickyProgressCount();
        }, { once: true });
      }

      // Handle completion of a stuck todo
      function completeStuckTodo(todoId) {
        var stuckItem = stuckTodos.get(todoId);
        if (!stuckItem) return;

        var cloneEl = stuckItem.cloneEl;

        // Change icon to checkmark
        var checkSvg = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';
        var iconEl = cloneEl.querySelector('.stuck-todo-icon');
        if (iconEl) {
          iconEl.innerHTML = checkSvg;
        }

        // Play completion animation
        cloneEl.classList.add('completing');

        cloneEl.addEventListener('animationend', function() {
          // Remove clone
          if (cloneEl.parentNode) {
            cloneEl.parentNode.removeChild(cloneEl);
          }

          // Disconnect observer
          var observer = stuckTodoObservers.get(todoId);
          if (observer) {
            observer.disconnect();
            stuckTodoObservers.delete(todoId);
          }

          // Clean up tracking
          stuckTodos.delete(todoId);

          // Hide container if empty
          var container = document.getElementById('sticky-progress-container');
          if (container && stuckTodos.size === 0) {
            container.classList.remove('has-items');
          }
          updateStickyProgressCount();
        }, { once: true });
      }

      // Setup IntersectionObserver for a todo element
      function setupTodoIntersectionObserver(todoElement) {
        var todoId = todoElement.getAttribute('data-todo-id');
        if (!todoId || stuckTodoObservers.has(todoId)) return;

        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        var observer = new IntersectionObserver(function(entries) {
          entries.forEach(function(entry) {
            if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
              // Item has scrolled above viewport - stick it
              stickTodoItem(todoElement, todoId);
            } else if (entry.isIntersecting && stuckTodos.has(todoId)) {
              // Item is back in view - unstick it
              unstickTodoItem(todoId);
            }
          });
        }, {
          root: messagesEl,
          threshold: 0,
          rootMargin: '-1px 0px 0px 0px' // Trigger right at the top edge
        });

        observer.observe(todoElement);
        stuckTodoObservers.set(todoId, observer);
      }

      // Find and observe all in-progress todo items
      function observeInProgressTodos() {
        // Clean up existing observers for items that are no longer in_progress
        var currentInProgressIds = new Set();
        var inProgressItems = document.querySelectorAll('.todo-item.in_progress');

        inProgressItems.forEach(function(item) {
          var todoId = item.getAttribute('data-todo-id');
          if (todoId) {
            currentInProgressIds.add(todoId);
            // Setup observer if not already observing
            if (!stuckTodoObservers.has(todoId)) {
              setupTodoIntersectionObserver(item);
            }
          }
        });

        // Disconnect observers for items no longer in_progress
        stuckTodoObservers.forEach(function(observer, todoId) {
          if (!currentInProgressIds.has(todoId)) {
            observer.disconnect();
            stuckTodoObservers.delete(todoId);
            // Also remove from stuckTodos if present
            if (stuckTodos.has(todoId)) {
              var stuckItem = stuckTodos.get(todoId);
              if (stuckItem.cloneEl && stuckItem.cloneEl.parentNode) {
                stuckItem.cloneEl.parentNode.removeChild(stuckItem.cloneEl);
              }
              if (stuckItem.originalEl) {
                stuckItem.originalEl.classList.remove('is-stuck');
              }
              stuckTodos.delete(todoId);
            }
          }
        });

        // Hide container if no stuck items
        var container = document.getElementById('sticky-progress-container');
        if (container && stuckTodos.size === 0) {
          container.classList.remove('has-items');
        }
      }

      // Initialize sticky progress observation with MutationObserver
      function initStickyProgressObserver() {
        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        // Observe for new todo items being added
        var mutationObserver = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
              if (node.nodeType === 1) { // Element node
                // Check for todo lists
                var todoLists = node.querySelectorAll ? node.querySelectorAll('.todo-list') : [];
                if (todoLists.length > 0 || (node.classList && node.classList.contains('todo-list'))) {
                  setTimeout(observeInProgressTodos, 50);
                }
              }
            });
          });
        });

        mutationObserver.observe(messagesEl, {
          childList: true,
          subtree: true
        });
      }

      function renderTodoList(todos) {
        if (!todos || !todos.length) return '';

        var html = '<div class="todo-list">';
        todos.forEach(function(todo) {
          var statusIcon = '';
          if (todo.status === 'completed') {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';
          } else if (todo.status === 'in_progress') {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8"/></svg>';
          } else {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
          }

          var todoId = generateTodoId(todo.content);
          var activeForm = todo.activeForm || todo.content;
          var displayText = todo.status === 'in_progress' ? activeForm : todo.content;

          html += '<div class="todo-item ' + todo.status + '" ' +
            'data-todo-id="' + todoId + '" ' +
            'data-todo-content="' + escapeHtml(todo.content) + '" ' +
            'data-todo-active-form="' + escapeHtml(activeForm) + '">' +
            '<span class="todo-status ' + todo.status + '">' + statusIcon + '</span>' +
            '<span class="todo-content">' + escapeHtml(displayText) + '</span>' +
          '</div>';
        });
        html += '</div>';
        return html;
      }

      // Update sticky todo progress indicator - now uses scroll-aware sticking
      function updateStickyTodos(todos) {
        // Build set of current in-progress todo contents
        var newInProgressContents = new Set();
        var newInProgressMap = new Map(); // content -> todo

        (todos || []).forEach(function(todo) {
          if (todo.status === 'in_progress') {
            newInProgressContents.add(todo.content);
            newInProgressMap.set(todo.content, todo);
          }
        });

        // Check for completed items that were stuck
        stuckTodos.forEach(function(stuckItem, todoId) {
          var content = stuckItem.originalEl.getAttribute('data-todo-content');
          if (content && !newInProgressContents.has(content)) {
            // This item was completed - animate it out
            completeStuckTodo(todoId);
          }
        });

        // Update previous state for next comparison
        previousTodoContents = newInProgressContents;
        currentTodos = todos || [];

        // Re-observe any new in-progress items (after a small delay for DOM update)
        setTimeout(function() {
          observeInProgressTodos();
        }, 50);
      }

      function renderEditReportCard(editInfo, thinkingContent) {
        var actionClass = editInfo.action;
        var actionLabel = editInfo.action.charAt(0).toUpperCase() + editInfo.action.slice(1);
        var bullet = '●';

        // Chevron SVG
        var chevronSvg = '<svg class="edit-report-chevron" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

        var html = '<div class="edit-report-card" data-file-path="' + escapeHtml(editInfo.filePath) + '">';

        // Thinking section (if available)
        if (thinkingContent && thinkingContent.trim()) {
          html += '<div class="edit-report-thinking">' +
            '<div class="edit-report-thinking-header">Thinking</div>' +
            '<div class="edit-report-thinking-content">' + escapeHtml(thinkingContent) + '</div>' +
          '</div>';
        }

        // File header
        html += '<div class="edit-report-file-header">' +
          '<span class="edit-report-bullet ' + actionClass + '">' + bullet + '</span>' +
          '<span class="edit-report-action ' + actionClass + '">' + actionLabel + '</span>' +
          '<span class="edit-report-filename">' + escapeHtml(editInfo.fileName) + '</span>' +
          chevronSvg +
        '</div>';

        // Stats line with tree connector
        var statsText = '';
        if (editInfo.linesAdded > 0) {
          statsText += '<span class="edit-report-stats-added">Added ' + editInfo.linesAdded + ' line' + (editInfo.linesAdded !== 1 ? 's' : '') + '</span>';
        }
        if (editInfo.linesRemoved > 0) {
          if (statsText) statsText += ', ';
          statsText += '<span class="edit-report-stats-removed">Removed ' + editInfo.linesRemoved + ' line' + (editInfo.linesRemoved !== 1 ? 's' : '') + '</span>';
        }
        if (!statsText) {
          statsText = 'No changes';
        }

        html += '<div class="edit-report-stats">' +
          '<span class="edit-report-stats-tree">└</span> ' + statsText +
        '</div>';

        // Diff content (collapsed by default)
        html += '<div class="edit-report-diff">';

        var maxPreviewLines = 20;
        var diffLines = editInfo.diffLines || [];
        var showLines = diffLines.slice(0, maxPreviewLines);
        var language = getLanguageFromPath(editInfo.filePath);

        showLines.forEach(function(line) {
          var prefix = line.type === 'addition' ? '+' : (line.type === 'deletion' ? '-' : ' ');
          var lineNum = line.lineNum ? line.lineNum : '';
          var highlightedContent = highlightCode(line.content, language);
          html += '<div class="edit-report-diff-line ' + line.type + '">' +
            '<span class="edit-report-diff-linenum">' + lineNum + '</span>' +
            '<span class="edit-report-diff-prefix">' + prefix + '</span>' +
            '<span class="edit-report-diff-content">' + highlightedContent + '</span>' +
          '</div>';
        });

        if (diffLines.length > maxPreviewLines) {
          html += '<div class="edit-report-show-more" data-full-diff="' + encodeURIComponent(JSON.stringify(diffLines)) + '" data-language="' + language + '">' +
            '... ' + (diffLines.length - maxPreviewLines) + ' more lines' +
          '</div>';
        }

        html += '</div>'; // end diff

        // Actions
        html += '<div class="edit-report-actions">' +
          '<button class="edit-report-btn edit-report-btn-revert" title="Revert changes (git checkout)">Revert</button>' +
          '<button class="edit-report-btn edit-report-btn-copy" title="Copy file path">Copy path</button>' +
          '<button class="edit-report-btn edit-report-btn-open" title="Open file in editor">Open file</button>' +
        '</div>';

        html += '</div>'; // end card

        return html;
      }

      function isDiffContent(content) {
        var lines = content.split('\n');
        var diffMarkers = 0;
        var checkLines = Math.min(lines.length, 20);

        for (var i = 0; i < checkLines; i++) {
          var line = lines[i];
          // Exclude CSS custom properties (--var) from diff detection
          if (line.startsWith('+') || (line.startsWith('-') && !line.startsWith('--')) || line.startsWith('@@')) {
            diffMarkers++;
          }
        }
        return diffMarkers > checkLines * 0.2;
      }

      function formatDiffContent(content) {
        var lines = content.split('\n');
        var html = '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var lineClass = 'diff-line';

          if (line.startsWith('+') && !line.startsWith('+++')) {
            lineClass += ' diff-addition';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            lineClass += ' diff-deletion';
          } else if (line.startsWith('@@')) {
            lineClass += ' diff-hunk';
          } else if (line.startsWith('diff ') || line.startsWith('index ') ||
                     line.startsWith('---') || line.startsWith('+++')) {
            lineClass += ' diff-header';
          }

          html += '<div class="' + lineClass + '">' + escapeHtml(line) + '</div>';
        }
        return html;
      }

      function formatContent(content) {
        if (!content) return '';

        // Use marked for full markdown parsing if available
        if (typeof marked !== 'undefined') {
          try {
            var html = marked.parse(content);

            // Schedule syntax highlighting and mermaid rendering
            setTimeout(function() {
              if (typeof Prism !== 'undefined') {
                Prism.highlightAll();
              }
              renderMermaidDiagrams();
            }, 0);

            return html;
          } catch (e) {
            console.error('Markdown parse error:', e);
          }
        }

        // Fallback to basic formatting if marked is not available
        var html = escapeHtml(content);
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\n/g, '<br>');
        return html;
      }

      document.addEventListener('click', function(e) {
        var slashMenuEl = document.getElementById('slash-menu');
        if (state.slashMenuVisible && slashCmdBtn && slashMenuEl && !slashCmdBtn.contains(e.target) && !slashMenuEl.contains(e.target) && !inputEl.contains(e.target)) {
          hideSlashMenu();
          if (inputEl.value.startsWith('/')) {
            inputEl.value = '';
            inputEl.style.height = 'auto';
          }
        }

        // Close mention menu when clicking outside (but not when clicking the input)
        var mentionMenuEl = document.getElementById('mention-menu');
        var inputEl = document.getElementById('message-input');
        if (mentionMenuEl && !mentionMenuEl.contains(e.target) && e.target !== inputEl) {
          hideMentionMenu();
        }

        // Close agent menu when clicking outside
        if (agentSelectBtn && agentMenu && !agentSelectBtn.contains(e.target) && !agentMenu.contains(e.target)) {
          agentMenu.classList.add('hidden');
        }

        // Handle copy button click
        var copyBtn = e.target.closest('.tool-call-copy');
        if (copyBtn) {
          e.stopPropagation();
          var toolCall = copyBtn.closest('.tool-call');
          if (toolCall && toolCall.dataset.summary) {
            postMessageWithPanelId({
              type: 'copyToClipboard',
              payload: toolCall.dataset.summary
            });
            // Visual feedback
            copyBtn.classList.add('copied');
            setTimeout(function() {
              copyBtn.classList.remove('copied');
            }, 1500);
          }
          return;
        }

        // Handle message copy button click (copy as Markdown with watermark)
        var msgCopyBtn = e.target.closest('.message-copy-btn');
        if (msgCopyBtn) {
          e.stopPropagation();
          var messageId = msgCopyBtn.dataset.messageId;
          if (messageId) {
            postMessageWithPanelId({
              type: 'copyMessageMarkdown',
              payload: { messageId: messageId }
            });
            // Visual feedback
            msgCopyBtn.classList.add('copied');
            setTimeout(function() {
              msgCopyBtn.classList.remove('copied');
            }, 1500);
          }
          return;
        }

        // Handle tool call expand/collapse
        var toolCallHeader = e.target.closest('.tool-call-header');
        if (toolCallHeader) {
          var toolCall = toolCallHeader.closest('.tool-call');
          if (toolCall) {
            toolCall.classList.toggle('expanded');
          }
        }

        // File Edit Card: Show more button
        var showMoreBtn = e.target.closest('.file-edit-show-more');
        if (showMoreBtn) {
          expandFileEditCard(showMoreBtn);
          return;
        }

        // File Edit Card: Collapse/expand toggle
        var collapseBtn = e.target.closest('.file-edit-collapse-btn');
        if (collapseBtn) {
          var card = collapseBtn.closest('.file-edit-card');
          if (card) {
            card.classList.toggle('collapsed');
          }
          return;
        }

        // File Edit Card: Revert button
        var revertBtn = e.target.closest('.file-edit-revert');
        if (revertBtn) {
          handleFileEditRevert(revertBtn);
          return;
        }

        // File Edit Card: Review button
        var reviewBtn = e.target.closest('.file-edit-review');
        if (reviewBtn) {
          handleFileEditReview(reviewBtn);
          return;
        }

        // ========================================
        // Edit Report Card Click Handlers
        // ========================================

        // Edit Report: Expand/collapse diff via file header click
        var editReportFileHeader = e.target.closest('.edit-report-file-header');
        if (editReportFileHeader) {
          var editReportCard = editReportFileHeader.closest('.edit-report-card');
          if (editReportCard) {
            editReportCard.classList.toggle('expanded');
          }
          return;
        }

        // Edit Report: Expand/collapse thinking section
        var editReportThinkingHeader = e.target.closest('.edit-report-thinking-header');
        if (editReportThinkingHeader) {
          var thinkingSection = editReportThinkingHeader.closest('.edit-report-thinking');
          if (thinkingSection) {
            thinkingSection.classList.toggle('expanded');
          }
          return;
        }

        // Edit Report: Copy path button
        var editReportCopyBtn = e.target.closest('.edit-report-btn-copy');
        if (editReportCopyBtn) {
          var editCard = editReportCopyBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            postMessageWithPanelId({
              type: 'copyToClipboard',
              payload: editCard.dataset.filePath
            });
            // Visual feedback
            var originalText = editReportCopyBtn.textContent;
            editReportCopyBtn.textContent = 'Copied!';
            setTimeout(function() {
              editReportCopyBtn.textContent = originalText;
            }, 1500);
          }
          return;
        }

        // Edit Report: Open file button
        var editReportOpenBtn = e.target.closest('.edit-report-btn-open');
        if (editReportOpenBtn) {
          var editCard = editReportOpenBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            // Use stored line number to open at the changed location (convert to 0-based)
            var lineNum = editCard.dataset.lineNumber ? parseInt(editCard.dataset.lineNumber, 10) - 1 : undefined;
            postMessageWithPanelId({
              type: 'openFile',
              payload: { path: editCard.dataset.filePath, line: lineNum }
            });
          }
          return;
        }

        // Edit Report: Revert button
        var editReportRevertBtn = e.target.closest('.edit-report-btn-revert');
        if (editReportRevertBtn) {
          var editCard = editReportRevertBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            editReportRevertBtn.textContent = 'Reverting...';
            editReportRevertBtn.disabled = true;
            postMessageWithPanelId({
              type: 'revertFileEdit',
              payload: { path: editCard.dataset.filePath }
            });
          }
          return;
        }

        // Edit Report: Show more lines in diff
        var editReportShowMore = e.target.closest('.edit-report-show-more');
        if (editReportShowMore) {
          expandEditReportDiff(editReportShowMore);
          return;
        }
      });

      // Expand file edit card to show all lines
      function expandFileEditCard(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        try {
          var fullDiffData = JSON.parse(decodeURIComponent(card.dataset.fullDiff));
          var diffContent = card.querySelector('.file-edit-diff-content');

          // Render all lines
          var html = '';
          for (var i = 0; i < fullDiffData.length; i++) {
            var dl = fullDiffData[i];
            html += '<div class="' + dl.cls + '">' +
              '<span class="file-edit-line-num">' + (dl.num !== '' ? dl.num : '') + '</span>' +
              '<span class="file-edit-line-content">' + escapeHtml(dl.content) + '</span>' +
            '</div>';
          }

          diffContent.innerHTML = html;
          btn.remove(); // Remove "Show more" button
          card.classList.add('expanded');
        } catch (e) {
          console.error('Failed to expand diff:', e);
        }
      }

      // Handle revert action
      function handleFileEditRevert(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        var filePath = card.dataset.filePath;
        postMessageWithPanelId({
          type: 'revertFileEdit',
          payload: { path: filePath }
        });

        // Visual feedback
        btn.textContent = 'Reverting...';
        btn.disabled = true;
      }

      // Handle review action (open file in editor)
      function handleFileEditReview(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        var filePath = card.dataset.filePath;
        postMessageWithPanelId({
          type: 'openFile',
          payload: { path: filePath }
        });
      }

      // Expand edit report diff to show all lines
      function expandEditReportDiff(btn) {
        var card = btn.closest('.edit-report-card');
        if (!card) return;

        try {
          var fullDiffData = JSON.parse(decodeURIComponent(btn.dataset.fullDiff));
          var language = btn.dataset.language || 'javascript';
          var diffContent = card.querySelector('.edit-report-diff');

          // Render all lines with syntax highlighting
          var html = '';
          for (var i = 0; i < fullDiffData.length; i++) {
            var line = fullDiffData[i];
            var prefix = line.type === 'addition' ? '+' : (line.type === 'deletion' ? '-' : ' ');
            var lineNum = line.lineNum ? line.lineNum : '';
            var highlightedContent = highlightCode(line.content, language);
            html += '<div class="edit-report-diff-line ' + line.type + '">' +
              '<span class="edit-report-diff-linenum">' + lineNum + '</span>' +
              '<span class="edit-report-diff-prefix">' + prefix + '</span>' +
              '<span class="edit-report-diff-content">' + highlightedContent + '</span>' +
            '</div>';
          }

          diffContent.innerHTML = html;
          btn.remove(); // Remove "Show more" button
        } catch (e) {
          console.error('Failed to expand edit report diff:', e);
        }
      }
    })();
  
