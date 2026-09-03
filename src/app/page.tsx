import { redirect } from "next/navigation";

// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs story.
// The giglist/table UI that used to live here moved to /gigs (see that
// route's own header comment) — this redirect is the interim state until
// the dependent dashboard-overview-page story replaces this file with the
// real Dashboard (sonar header + glance tiles + Today teaser + compact
// metrics). Redirect, not a blank/placeholder page, so nothing in the app
// that still links to "/" breaks in the gap between the two stories.
export default function HomePage() {
  redirect("/gigs");
}
