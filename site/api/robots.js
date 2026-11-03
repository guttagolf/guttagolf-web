// GET /robots.txt (rewritten here by vercel.json)
// Search engines may index the real domain only; the test address on vercel.app stays out of Google until the switch.
const SITE = "https://guttagolf.ca";

module.exports = (req, res) => {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const live = host === "guttagolf.ca" || host === "www.guttagolf.ca";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(live
    ? `User-agent: *\nDisallow: /admin.html\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n");
};
