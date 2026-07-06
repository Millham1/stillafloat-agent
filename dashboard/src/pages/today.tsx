import { useEffect } from "react";

// ONE brief surface (Mark, 2026-07-06): the dashboard's Today page was a
// duplicate of the brief. The brief itself (brief.html, same origin — shared
// token + push) is the single surface on phone and desktop; /today now just
// forwards there so old links and habits keep working.
export default function Today() {
  useEffect(() => {
    window.location.replace("/brief.html");
  }, []);
  return (
    <div className="p-6 text-sm text-muted-foreground">
      Opening your brief… <a className="underline" href="/brief.html">tap here if it doesn’t load</a>.
    </div>
  );
}
