import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface RouteState {
  path: string;
  /** First path segment — the active use-case key ("" at the root). */
  useCaseKey: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouteState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string): void => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
  };
  const useCaseKey = decodeURIComponent(path.split("/").filter(Boolean)[0] ?? "");
  return <RouterContext.Provider value={{ path, useCaseKey, navigate }}>{children}</RouterContext.Provider>;
}

export function useRoute(): RouteState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRoute must be used within RouterProvider");
  return ctx;
}
