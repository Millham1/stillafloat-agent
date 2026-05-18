const AGENT_BASE_URL = '';

async function loadPlatformStatus() {
  try {
    const response = await fetch(`${AGENT_BASE_URL}/api/system-status`);
    const data = await response.json();

    if (!data.success) {
      return;
    }

    const existing = document.getElementById('platform-status-banner');

    if (existing) {
      existing.remove();
    }

    const banner = document.createElement('div');
    banner.id = 'platform-status-banner';

    const degraded = Boolean(data.pipeline?.degradedMode);

    banner.style.cssText = `
      width:100%;
      padding:10px 18px;
      text-align:center;
      font-size:13px;
      font-weight:800;
      letter-spacing:.04em;
      position:sticky;
      top:0;
      z-index:9999;
      backdrop-filter:blur(12px);
      border-bottom:1px solid rgba(255,255,255,.08);
      background:${
        degraded
          ? 'rgba(255,77,109,.88)'
          : 'rgba(9,72,117,.88)'
      };
      color:white;
    `;

    if (degraded) {
      banner.textContent = `Still Afloat AI is operating in degraded mode: ${data.pipeline?.degradedReason || 'AI orchestration unavailable'}`;
    } else {
      banner.textContent = `Still Afloat AI operational • ${data.publishing?.approvedStories || 0} approved stories available`;
    }

    document.body.prepend(banner);
  } catch (error) {
    console.error('Platform status unavailable', error);
  }
}

window.addEventListener('DOMContentLoaded', loadPlatformStatus);