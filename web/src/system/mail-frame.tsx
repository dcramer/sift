/**
 * A message as its own HTML, on the white paper email is written for. The frame runs nothing and loads
 * nothing from elsewhere (the server sends its document under a policy of its own); links open in a new
 * tab. It cannot measure what it holds, so it scrolls inside, 70% of the screen tall. Empty paper until
 * `src` is given and while it loads.
 */
export function MailFrame({ src, title }: { src?: string | undefined; title: string }) {
  return (
    <div className="h-[70svh] min-h-64 bg-(--paper)">
      <iframe src={src} title={title} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="block size-full" />
    </div>
  );
}
