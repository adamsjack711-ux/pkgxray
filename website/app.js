// Homepage interactions: local examples and command copying only.
// No packages are downloaded, analyzed, or executed by the browser.
const EXAMPLES = {
  safe: {
    command: 'pkgxray guard npm:express@4.21.0', stage: 'Tarball staged in quarantine',
    verdict: 'SAFE', exit: 'exit 0', label: 'NO HIGH- OR MEDIUM-RISK FINDINGS',
    evidence: 'The default policy permits promotion from quarantine.',
    citation: 'npm:express@4.21.0',
    note: 'SAFE means no high- or medium-risk indicators were found. It is not proof that a package is harmless.'
  },
  review: {
    command: 'pkgxray guard ./example-package', stage: 'Package staged in quarantine',
    verdict: 'REVIEW', exit: 'exit 3', label: 'MEDIUM · INSTALL SCRIPT',
    evidence: 'A lifecycle script needs a human to inspect it before promotion.',
    citation: 'package.json → scripts.postinstall',
    note: 'Illustrative install-script finding. REVIEW also covers incomplete evidence; inspect the quarantined copy before proceeding.'
  },
  block: {
    command: 'pkgxray --file ./pkgxray-onboarding.json', stage: 'Inert source evidence loaded',
    verdict: 'BLOCK', exit: 'exit 2', label: 'HIGH · CREDENTIAL ACCESS',
    evidence: 'The inert example contains a private-key read and an outbound transfer.',
    citation: 'index.js → cited source evidence',
    note: 'Illustrative result from inert source text. BLOCK means high-severity evidence was found: stop and investigate.'
  }
};

const COMMANDS = {
  package: {
    code: 'npx --yes pkgxray@1.1.0 guard npm:express@4.21.0',
    help: 'Downloads the package into quarantine and inspects it. The package’s install scripts and code are not executed.'
  },
  lockfile: {
    code: 'npx --yes pkgxray@1.1.0 audit package-lock.json',
    help: 'Run from a project containing package-lock.json to check its dependency evidence. Add --deep to download and inspect dependency source.'
  },
  python: {
    code: 'npx --yes pkgxray@1.1.0 audit requirements.txt',
    help: 'Run from a Python project with requirements.txt. PyPI checks have narrower coverage than npm; general Python behavioral analysis is not implemented.'
  }
};

function initTabs(selector, attribute, activate) {
  const tabs = [...document.querySelectorAll(selector)];
  function select(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    activate(tab.dataset[attribute], tab.id);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        select(tabs[next], true);
      }
    });
  });
}

initTabs('[data-example]', 'example', (key, id) => {
  const example = EXAMPLES[key];
  const panel = document.querySelector('#scan-result');
  panel.dataset.state = key;
  panel.setAttribute('aria-labelledby', id);
  for (const [field, value] of Object.entries(example)) {
    document.querySelector(`[data-demo-${field}]`).textContent = value;
  }
  document.querySelector('.inspection-heading > span:last-child').textContent = `${String(Object.keys(EXAMPLES).indexOf(key) + 1).padStart(2, '0')} / 03`;
});

initTabs('[data-command]', 'command', (key, id) => {
  const command = COMMANDS[key];
  document.querySelector('#command-panel').setAttribute('aria-labelledby', id);
  document.querySelector('[data-command-code]').textContent = command.code;
  document.querySelector('[data-command-help]').textContent = command.help;
  document.querySelector('[data-command-copy]').dataset.copy = command.code;
});

let statusTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const status = document.querySelector('[data-copy-status]');
    const label = button.querySelector('[data-copy-label]');
    clearTimeout(statusTimer);
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = 'Copied';
      status.textContent = 'Command copied. Paste it into your terminal.';
      window.setTimeout(() => { label.textContent = 'Copy'; }, 2200);
    } catch {
      status.textContent = 'Copy unavailable. Select and copy the command text above.';
    }
    statusTimer = window.setTimeout(() => { status.textContent = ''; }, 4000);
  });
}

const menuButton = document.querySelector('.menu-toggle');
const menu = document.querySelector('#primary-nav');
function setMenu(open) {
  menuButton.setAttribute('aria-expanded', String(open));
  menu.classList.toggle('is-open', open);
  menuButton.querySelector('span').textContent = open ? '−' : '+';
}
menuButton.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menuButton.focus();
  }
});
document.body.classList.add('has-js');
