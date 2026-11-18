// "how did you hear about us?": asked at checkout (required), so we can look back at where our buyers come from.
// The answer is tagged on the Square order two ways: metadata heard_from (the id, exact, for counting) and a line in
// the payment note ("found us: google"), which shows on the payment in the Square dashboard.
// To add a choice, add it here: the checkout page builds its drop-down from this list (via /api/catalog).
export const HEARD_FROM = [
  { id: 'friends-family', label: 'friends & family' },
  { id: 'word-of-mouth', label: 'word of mouth' },
  { id: 'spca', label: 'spca' },
  { id: 'etsy', label: 'etsy' },
  { id: 'google', label: 'google' }
];

// the choice the browser sent, or null when it isn't one of ours
export function cleanHeardFrom(raw) {
  return HEARD_FROM.find((h) => h.id === raw) || null;
}
