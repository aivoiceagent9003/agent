import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Cross-fade between pages via the browser's View Transitions API (styled in
    // styles.css). Browsers without it just navigate instantly.
    defaultViewTransition: true,
  });

  return router;
};
