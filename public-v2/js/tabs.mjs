import { TAB_SECTIONS, getSectionId } from './format.mjs';

export function initTabs() {
  const buttons = document.querySelectorAll('#tab-bar button[data-tab]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      Object.keys(TAB_SECTIONS).forEach((tabKey) => {
        document.getElementById(getSectionId(tabKey)).classList.toggle('hidden', tabKey !== button.dataset.tab);
      });
      buttons.forEach((b) => b.classList.toggle('active', b === button));
    });
  });
}

initTabs();
