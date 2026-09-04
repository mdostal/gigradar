import { loadConfigPageData } from "./config-data";
import { ConfigSidebar } from "./config-sidebar";

// config-dashboard-and-section-pages story: wraps every /config/* route
// (the dashboard home AND every /config/[section] page) with the same
// persistent, collapsible sidebar — owner's own synthesis: "the side view
// lets you skip to the fullpage section." loadConfigPageData() is
// `cache()`-wrapped (config-data.ts) so calling it here AND again in
// page.tsx/[section]/page.tsx costs one real data load per request, not
// two.
export const dynamic = "force-dynamic";

export default async function ConfigLayout({ children }: { children: React.ReactNode }) {
  const data = await loadConfigPageData();

  return (
    <div className="flex min-h-screen">
      <ConfigSidebar data={data} />
      <div className="flex-1 overflow-x-auto">{children}</div>
    </div>
  );
}
