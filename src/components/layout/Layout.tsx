import { Outlet } from "react-router-dom";
import { Titlebar } from "./Titlebar";

/**
 * Root layout shell — frameless titlebar + page content.
 */
export function Layout() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Titlebar />
      <main className="flex-1 mt-10 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
