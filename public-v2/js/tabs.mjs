import { TAB_SECTIONS, getSectionId } from './format.mjs';
import { resizeChart } from './chart.mjs';
import { resizeIndicatorPanel } from './regime-band.mjs';

export function initTabs() {
  // Desktop header nav and the phone bottom nav are two separate button groups that both use
  // data-tab — querying all of them (not just #tab-bar's) keeps the two navs in sync regardless
  // of which one is visible at the current viewport width.
  const buttons = document.querySelectorAll('[data-tab]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const tabKey = button.dataset.tab;
      Object.keys(TAB_SECTIONS).forEach((key) => {
        document.getElementById(getSectionId(key)).classList.toggle('hidden', key !== tabKey);
      });
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabKey));
      // lightweight-charts sizes itself off the container's width at creation time, which is 0
      // while its tab is display:none — switching to the Charts tab must force a resize, or the
      // chart stays permanently sized to nothing no matter what data arrives afterward.
      if (tabKey === 'charts') { resizeChart(); resizeIndicatorPanel(); }
    });
  });
}

initTabs();
