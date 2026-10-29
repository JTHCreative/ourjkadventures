// j+k adventures: who may use the admin pages. The shop's own account, with its email confirmed.
// ADMIN_EMAILS (plain Cloudflare variable, comma separated) can replace the default list.
// An unconfirmed account can't pass even with the right address: confirming needs that inbox.

const DEFAULT_ADMINS = 'ourjkadventures@gmail.com';

export function isAdmin(user, env) {
  if (!user || user.email_verified !== true || typeof user.email !== 'string') return false;
  const list = String((env && env.ADMIN_EMAILS) || DEFAULT_ADMINS).split(',')
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(user.email.trim().toLowerCase());
}
