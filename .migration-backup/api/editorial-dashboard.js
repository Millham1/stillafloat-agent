module.exports = async function handler(req, res) {
  return res.status(200).send(`
    <html>
      <body>
        <h1>Still Afloat Editorial Dashboard</h1>
        <p>Dashboard online.</p>
      </body>
    </html>
  `);
};