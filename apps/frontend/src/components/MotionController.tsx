import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

const revealSelector = [
  ".auth-panel",
  ".sidebar-header",
  ".nav-links a",
  ".account-box",
  ".shell-topbar",
  ".hero-card",
  ".card",
  ".dashboard-strip > *",
  ".hero-metrics > *",
  ".timeline-grid > *",
  ".connection-grid > *",
  ".dashboard-tabs > *",
  ".dashboard-focus-grid > *",
  ".dashboard-signal-grid > *",
  ".dashboard-feed-list > *",
  ".dashboard-appointment-list > *",
  ".dashboard-calendar-grid > *",
  ".dashboard-day-list > *",
  ".dashboard-report-grid > *",
  ".dashboard-module-grid > *",
  ".stacked-list > *",
  ".event-list > *",
  ".db-row-list > *",
  ".push-status-grid > *",
  ".db-meta-grid > *",
  ".field-chips > *",
  ".db-browser-shell",
  ".sql-console-results > *",
  ".warning-banner",
  ".error-banner",
  ".success-banner",
  ".empty-state",
].join(", ");

function collectTargets(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(revealSelector));
}

function siblingRevealIndex(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) {
    return 0;
  }

  const siblings = Array.from(parent.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(revealSelector),
  );

  return Math.max(0, siblings.indexOf(element));
}

export function MotionController() {
  const location = useLocation();

  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("motion-ready");

    const prepared = new WeakSet<HTMLElement>();
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting && entry.intersectionRatio <= 0.12) {
            return;
          }

          const target = entry.target as HTMLElement;
          target.classList.add("is-visible");
          revealObserver.unobserve(target);
        });
      },
      {
        threshold: 0.16,
        rootMargin: "0px 0px -8% 0px",
      },
    );

    const registerTargets = (targets: HTMLElement[]) => {
      targets.forEach((target) => {
        if (prepared.has(target)) {
          return;
        }

        prepared.add(target);
        target.dataset.motionReady = "true";
        target.style.setProperty("--reveal-order", String(siblingRevealIndex(target) % 7));
        revealObserver.observe(target);
      });
    };

    registerTargets(collectTargets(document));

    const mutationObserver = new MutationObserver((records) => {
      const nextTargets: HTMLElement[] = [];

      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }

          if (node.matches(revealSelector)) {
            nextTargets.push(node);
          }

          nextTargets.push(...collectTargets(node));
        });
      });

      if (nextTargets.length > 0) {
        registerTargets(nextTargets);
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    const syncScrollState = () => {
      html.dataset.scrolled = window.scrollY > 16 ? "true" : "false";
    };

    syncScrollState();
    window.addEventListener("scroll", syncScrollState, { passive: true });

    return () => {
      mutationObserver.disconnect();
      revealObserver.disconnect();
      window.removeEventListener("scroll", syncScrollState);
    };
  }, [location.pathname]);

  return null;
}
