// j+k adventures: the Meta Pixel's number ("JK Adventures Website Pixel" in Meta's Events Manager), kept in this one
// spot. The browser (assets/pixel.js) and the server (server/meta.js) both read it from here. It isn't a secret:
// it's in every page that uses the Pixel. The Conversions API key is the secret one, and lives only in Cloudflare
// (server/meta.js).
export const META_PIXEL_ID = '1691266879364899';
