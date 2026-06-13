    (function() {
      var vscode = acquireVsCodeApi();
      var issueCount = 0;
      var actionCount = 0;
      var isRunning = false;

      // ── Elements ──
      var statusEl = document.getElementById('vt-status');
      var cancelBtn = document.getElementById('vt-cancel');
      var configPanel = document.getElementById('vt-config');
      var progressPanel = document.getElementById('vt-progress');
      var screenshotEl = document.getElementById('vt-screenshot');
      var issuesEl = document.getElementById('vt-issues');
      var issueCountEl = document.getElementById('vt-issue-count');
      var actionsEl = document.getElementById('vt-actions');
      var reportEl = document.getElementById('vt-report');

      // ── Config → Start ──
      document.getElementById('vt-start').addEventListener('click', function() {
        var requirements = document.getElementById('cfg-requirements').value.trim();
        if (!requirements) {
          document.getElementById('cfg-requirements').focus();
          return;
        }

        var config = {
          url: document.getElementById('cfg-url').value || 'http://localhost:3000',
          devServerCommand: document.getElementById('cfg-dev-cmd').value || undefined,
          requirements: requirements,
          maxIterations: parseInt(document.getElementById('cfg-max-iter').value || '5', 10),
          screenshotMode: document.getElementById('cfg-screenshot-mode').value || 'viewport',
          elementSelector: document.getElementById('cfg-element-selector').value || undefined,
          browser: document.getElementById('cfg-browser').value || 'chromium',
          headless: true,
          viewportWidth: 1280,
          viewportHeight: 720,
          interactionsEnabled: document.getElementById('cfg-interactions').checked
        };

        vscode.postMessage({ type: 'dashboardStartVisualTest', payload: { config: config } });
        switchToProgress();
      });

      // ── Cancel ──
      cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'dashboardCancelVisualTest' });
        setStatus('Cancelling...', 'cancelled');
      });

      function switchToProgress() {
        configPanel.classList.add('hidden');
        progressPanel.classList.add('active');
        cancelBtn.classList.remove('hidden');
        isRunning = true;
        issueCount = 0;
        actionCount = 0;
        issuesEl.innerHTML = '';
        actionsEl.innerHTML = '';
        screenshotEl.innerHTML = 'Waiting for first screenshot...';
        issueCountEl.textContent = '0';
        reportEl.classList.remove('active');
        setStatus('Starting...', 'running');
      }

      function switchToConfig() {
        configPanel.classList.remove('hidden');
        progressPanel.classList.remove('active');
        cancelBtn.classList.add('hidden');
        isRunning = false;
        setStatus('Idle', 'idle');
      }

      function setStatus(text, state) {
        statusEl.textContent = text;
        statusEl.className = 'vt-status-badge vt-status-' + state;
      }

      function addAction(icon, text, badge) {
        if (actionCount === 0) { actionsEl.innerHTML = ''; }
        actionCount++;
        var item = document.createElement('div');
        item.className = 'vt-action-item';
        var iconHtml = '<span class="vt-action-icon ' + (icon === 'done' ? 'done' : 'running') + '">'
          + (icon === 'done' ? '\u2713' : '\u25CB') + '</span>';
        var badgeHtml = badge ? ' <span class="vt-action-badge">' + escapeHtml(badge) + '</span>' : '';
        item.innerHTML = iconHtml + '<span>' + escapeHtml(text) + badgeHtml + '</span>';
        actionsEl.appendChild(item);
        actionsEl.scrollTop = actionsEl.scrollHeight;
      }

      function addIssue(issue) {
        if (issueCount === 0) { issuesEl.innerHTML = ''; }
        issueCount++;
        issueCountEl.textContent = issueCount.toString();
        var item = document.createElement('div');
        item.className = 'vt-issue-item';
        item.innerHTML = '<span class="vt-severity vt-severity-' + issue.severity + '">'
          + escapeHtml(issue.severity) + '</span>'
          + '<span>' + escapeHtml(issue.description) + '</span>';
        issuesEl.appendChild(item);
      }

      function showReport(report) {
        if (!report || !report.summary) return;
        var s = report.summary;
        var verdictEl = document.getElementById('vt-verdict');
        var cls = s.verdict === 'pass' ? 'pass' : s.verdict === 'partial' ? 'partial' : 'fail';
        verdictEl.className = 'vt-verdict vt-verdict-' + cls;
        verdictEl.textContent = s.verdict.toUpperCase();
        document.getElementById('vt-report-iterations').textContent = s.totalIterations + '/' + s.maxIterations + ' iterations';
        document.getElementById('vt-report-issues').textContent = s.totalIssuesFound + ' issues, ' + s.totalIssuesFixed + ' fixed';
        document.getElementById('vt-report-duration').textContent = s.totalDuration ? Math.round(s.totalDuration / 1000) + 's' : '';
        reportEl.classList.add('active');
      }

      function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // ── Message handler ──
      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg) return;

        switch (msg.type) {
          case 'visualTestDashboardConfig': {
            // Pre-fill config from agent trigger
            var c = msg.payload;
            if (c) {
              if (c.url) document.getElementById('cfg-url').value = c.url;
              if (c.devServerCommand) document.getElementById('cfg-dev-cmd').value = c.devServerCommand;
              if (c.requirements) document.getElementById('cfg-requirements').value = c.requirements;
              if (c.maxIterations) document.getElementById('cfg-max-iter').value = c.maxIterations.toString();
              if (c.screenshotMode) document.getElementById('cfg-screenshot-mode').value = c.screenshotMode;
              if (c.elementSelector) document.getElementById('cfg-element-selector').value = c.elementSelector;
              if (c.browser) document.getElementById('cfg-browser').value = c.browser;
              if (c.interactionsEnabled !== undefined) document.getElementById('cfg-interactions').checked = c.interactionsEnabled;
            }
            break;
          }

          case 'visualTestDashboardAutoStart': {
            // Agent triggered — auto-fill and start immediately
            var cfg = msg.payload;
            if (cfg) {
              if (cfg.url) document.getElementById('cfg-url').value = cfg.url;
              if (cfg.devServerCommand) document.getElementById('cfg-dev-cmd').value = cfg.devServerCommand;
              if (cfg.requirements) document.getElementById('cfg-requirements').value = cfg.requirements;
              if (cfg.maxIterations) document.getElementById('cfg-max-iter').value = cfg.maxIterations.toString();
            }
            switchToProgress();
            break;
          }

          case 'visualTestDashboardUpdate': {
            var chunk = msg.payload;
            if (!chunk) break;
            handleChunk(chunk);
            break;
          }

          case 'visualTestDashboardCancelled':
            setStatus('Cancelled', 'cancelled');
            cancelBtn.classList.add('hidden');
            isRunning = false;
            addAction('done', 'Visual test cancelled');
            break;
        }
      });

      function handleChunk(chunk) {
        switch (chunk.type) {
          case 'visual_test_started':
            setStatus(chunk.message || chunk.status || 'Starting...', 'running');
            addAction('running', chunk.message || 'Visual test started');
            break;

          case 'visual_test_screenshot':
            setStatus('Captured screenshot', 'running');
            if (chunk.screenshot && chunk.screenshot.base64Data) {
              screenshotEl.innerHTML = '<img src="data:image/png;base64,' + chunk.screenshot.base64Data
                + '" alt="Iteration ' + chunk.screenshot.iteration + '" />';
            }
            addAction('done', 'Screenshot captured (iteration ' + (chunk.screenshot ? chunk.screenshot.iteration : '?') + ')');
            break;

          case 'visual_test_iteration':
            if (chunk.iteration) {
              var n = chunk.iteration.number;
              var ic = chunk.iteration.issues ? chunk.iteration.issues.length : 0;
              var dur = Math.round((chunk.iteration.duration || 0) / 1000);
              setStatus('Iteration ' + n + ' complete', 'running');
              addAction('done', 'Iteration ' + n + ': ' + ic + ' issue(s) found', dur + 's');
            }
            break;

          case 'visual_test_issue':
            if (chunk.issue) {
              addIssue(chunk.issue);
            }
            break;

          case 'visual_test_fix': {
            setStatus(chunk.message || 'Applying fix...', 'running');
            var badge = '';
            if (chunk.toolDetail) {
              if (chunk.toolDetail.linesAdded || chunk.toolDetail.linesRemoved) {
                badge = '+' + (chunk.toolDetail.linesAdded || 0) + '/-' + (chunk.toolDetail.linesRemoved || 0);
              }
            }
            addAction(chunk.message && chunk.message.startsWith('Completed') ? 'done' : 'running',
              chunk.message || 'Applying fix...', badge);
            break;
          }

          case 'visual_test_interaction':
            if (chunk.interaction) {
              var desc = chunk.interaction.action;
              if (chunk.interaction.target) desc += ' on ' + chunk.interaction.target;
              addAction('running', 'Action: ' + desc);
            }
            break;

          case 'visual_test_error':
            setStatus('Error', 'failed');
            addAction('done', 'ERROR: ' + (chunk.message || 'Unknown error'));
            break;

          case 'visual_test_complete':
            isRunning = false;
            cancelBtn.classList.add('hidden');
            var verdict = chunk.report && chunk.report.summary ? chunk.report.summary.verdict : 'fail';
            setStatus(verdict === 'pass' ? 'Passed' : verdict === 'partial' ? 'Partial' : 'Failed',
              verdict === 'pass' ? 'complete' : 'failed');
            addAction('done', 'Visual test complete');
            if (chunk.report) showReport(chunk.report);
            break;
        }
      }

    })();
