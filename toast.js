// toast.js — Minimal toast notification system
(function() {
  function showToast(message, type, duration) {
    type = type || 'info';
    if (duration === undefined) duration = 4000;

    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    var icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = '<span class="toast-icon">' + (icons[type] || icons.info) + '</span><span class="toast-msg">' + message + '</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>';
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(function() { toast.classList.add('show'); });

    if (duration > 0) {
      setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.remove(); }, 300);
      }, duration);
    }
  }

  window.showToast = showToast;
})();
