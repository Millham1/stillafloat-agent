const directive = require('./editorial-directive');

async function runEditorialAgent({ stories = [], openai }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openai}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: directive
        },
        {
          role: 'user',
          content: JSON.stringify({ stories })
        }
      ]
    })
  });

  const payload = await response.json();

  return JSON.parse(payload.choices[0].message.content);
}

module.exports = {
  runEditorialAgent
};