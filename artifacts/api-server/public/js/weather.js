const weatherContainer = document.getElementById('weather-container');

const ports = [
  {name:'Miami', slug:'miami', lat:25.7617, lon:-80.1918},
  {name:'Nassau', slug:'nassau', lat:25.0443, lon:-77.3504},
  {name:'Canaveral', slug:'port-canaveral', lat:28.4089, lon:-80.6043},
  {name:'Tampa', slug:'tampa', lat:27.9506, lon:-82.4572}
];

function emoji(code){
  if([0].includes(code)) return '☀️';
  if([1,2].includes(code)) return '🌤️';
  if([3].includes(code)) return '☁️';
  if([45,48].includes(code)) return '🌫️';
  if([51,53,55,61,63,65,80,81,82].includes(code)) return '🌧️';
  if([95,96,99].includes(code)) return '⛈️';
  return '⛅';
}

async function loadWeather(){
  if(!weatherContainer) return;

  weatherContainer.innerHTML = '<div style="color:white;padding:20px;">Loading live port weather...</div>';

  try{
    const cards = await Promise.all(ports.map(async port => {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${port.lat}&longitude=${port.lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
      const data = await res.json();

      return `
        <a class="home-weather-tile" href="forecast.html?place=${port.slug}">
          <div class="home-weather-emoji">${emoji(data.current.weather_code)}</div>
          <div class="home-weather-location">${port.name}</div>
          <div class="home-weather-temp">${Math.round(data.current.temperature_2m)}°</div>
        </a>
      `;
    }));

    weatherContainer.innerHTML = cards.join('');

  } catch(err){
    console.error(err);
    weatherContainer.innerHTML = '<div style="color:white;padding:20px;">Unable to load weather right now.</div>';
  }
}

loadWeather();