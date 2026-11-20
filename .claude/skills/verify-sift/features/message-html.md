# Read a message as its HTML

An opened message Sift holds the HTML of shows it as that HTML, or as its text. The HTML is what Sift stored, not fetched from Gmail; it runs no script and loads nothing from elsewhere. HTML is the default, and the choice is kept in the browser.

## Sub-features

- `html-toggle`: the `Read it as` choice (`Text`, `HTML`) above the message, with `Remote images are blocked` beside it while HTML shows. Not shown when Sift holds no HTML for the message: mail held as text alone (`m6`), or not held at all (`m1`, which says `Sift does not hold this message’s text. It keeps it only while the message waits on you, and for good once you have answered for it.`).
- `html-frame`: the frame, titled with the subject, white. Links in it open in a new tab.
- `html-none`: the frame's address answers 404 with `Sift does not hold this message’s HTML.` for a message it holds none of. The page hides the toggle then, so no user path reaches it.

## How to get to it (user POV)

- Open any message from For review or Activity; it shows as HTML unless the reader last chose `Text`.

## Driving it with verify.sh

Preconditions:

- Fresh seed and a fresh browser session (`up` gives one); `ab console` empty.

- **HTML by default.** `ab open "$B/?message=m4"`. `Read it as` has `HTML` checked (`ab snapshot -i` shows `radio "HTML" [checked=true]`), `Remote images are blocked` beside it, and a frame named `48 hours only: 30% off` showing `30% off everything` on a cream page with a white card, a `Shop the sale` button and, where the hero would be, its alt text `48 hours only` (a remote image's address is dropped, so nothing is fetched). `ab network requests` lists `/api/message/html?account=me%40example.org&id=m4` and nothing on `images.example.com` or `track.example.com`.
- **A link.** `ab snapshot -i` and click the frame's `Shop the sale` by its ref (`find role link` does not reach into the frame): `ab tab` lists a second tab at `https://shop.example.com/sale`; `ab tab close t2`. `Preferences` (a `javascript:` link in the source) is plain text, not a link.
- **Text, remembered.** `ab find role radio click --name "Text"`: the frame and `Remote images are blocked` go, `Everything must go.` shows, and `ab eval "localStorage.getItem('sift:message-view')"` is `"text"`. `ab reload`: `Text` is still chosen. `ab find role radio click --name "HTML"` brings the frame back.
- **Nothing to choose.** `?message=m6` and `ab open "$B/activity?show=all&message=m1"` have no `Read it as`; m1 says `Sift does not hold this message’s text.`
- **Phone.** `ab set viewport 390 844`, open m4: the frame is the reader's width and `document.documentElement.scrollWidth - document.documentElement.clientWidth` is `0`. m4's card is wider than the frame and is cut off at its right edge (`ab screenshot`).

## Gotchas

- Sift holds a message's HTML while it waits on the user, and for good once answered (in its example), so m4 still shows as HTML after Answer a suggestion. Mail a rule or a label decided has none.
- `ab console` does not report what happens inside the frame. The CSS background in m4 is blocked by the frame's policy, which shows in the network list as no request.
