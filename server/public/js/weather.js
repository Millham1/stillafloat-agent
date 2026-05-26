const weatherContainer = document.getElementById('weather-container');

async function loadWeather() {
  if (!weatherContainer) return;

  weatherContainer.innerHTML = '<div style="color:white;padding:20px;">Loading live port weather...</div>';

  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error('Weather fetch failed');
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Unknown error');

    const ports = (data.embarkation || []).slice(0, 7);

    if (ports.length === 0) throw new Error('No ports returned');

    weatherContainer.innerHTML = ports.map(port => `
      <a class="home-weather-tile" href="forecast.html?place=${port.slug}">
        <div class="home-weather-emoji">${port.emoji}</div>
        <div class="home-weather-location">${port.name.replace(/, .*/, '')}</div>
        <div class="home-weather-temp">${port.temp}°</div>
      </a>
    `).join('');

  } catch (err) {
    console.error('Weather load error:', err);
    weatherContainer.innerHTML = '<div style="color:white;padding:20px;">Unable to load weather right now.</div>';
  }
}

loadWeather();
