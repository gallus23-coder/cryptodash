import { TAB_SECTIONS, getSectionId } from './format.mjs';
import { resizeChart } from './chart.mjs';

export function initTabs() {
  const buttons = document.querySelectorAll('#tab-bar button[data-tab]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      Object.keys(TAB_SECTIONS).forEach((tabKey) => {
        document.getElementById(getSectionId(tabKey)).classList.toggle('hidden', tabKey !== button.dataset.tab);
      });
      buttons.forEach((b) => b.classList.toggle('active', b === button));
      // lightweight-charts sizes itself off the container's width at creation time, which is 0
      // while its tab is display:none — switching to the Charts tab must force a resize, or the
      // chart stays permanently sized to nothing no matter what data arrives afterward.
      if (button.dataset.tab === 'charts') resizeChart();
    });
  });
}

initTabs();
