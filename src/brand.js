// The group's name and logo. The code ships as plain "Sunday Ball"; a deployment sets its
// own in wrangler.toml [vars] without changing any code:
//   GROUP_NAME = "Riverside Sunday Ball"   texts, calendar events, page title, link previews
//   WORDMARK   = "RIVERSIDE / SUNDAY BALL" the two lines of the logo at the top of the app
//   LOGO_TEXT  = "RS"                      the letters in the tip-off intro (two work best)
// A deployment's own home-screen icons can go in the images table (see scripts/icons.mjs).
export const DEFAULT_BRAND = { name: "Sunday Ball", wordmark: ["SUNDAY", "BALL"], logo: "SB" };

export function brand(env = {}) {
  const [top, sub = ""] = String(env.WORDMARK || "").split("/").map(s => s.trim());
  return {
    name: String(env.GROUP_NAME || "").trim() || DEFAULT_BRAND.name,
    wordmark: top ? [top, sub] : DEFAULT_BRAND.wordmark,
    logo: String(env.LOGO_TEXT || "").trim() || DEFAULT_BRAND.logo,
  };
}

/** True when the deployment sets any of its own branding. */
export const customBrand = env => !!(env.GROUP_NAME || env.WORDMARK || env.LOGO_TEXT);

export const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Puts the group's name and logo into the app's page (public/index.html). */
export function brandPage(html, b) {
  const put = (re, value) => { html = html.replace(re, (_, before) => before + escapeHtml(value)); };
  put(/(<title>)[^<]*/, b.name);
  put(/(<meta name="application-name" content=")[^"]*/, b.name);
  put(/(<meta name="logo-text" content=")[^"]*/, b.logo);
  put(/(<a class="brand"[^>]*aria-label=")[^"]*/, b.name);
  put(/(<text class="wm-name"[^>]*>)[^<]*/, b.wordmark[0]);
  put(/(<text class="wm-sub"[^>]*>)[^<]*/, b.wordmark[1]);
  return html;
}

/** The home-screen icons a deployment can replace with its own (images table, key "icon:<file>"). */
export const ICON_FILES = ["icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon-32.png"];
