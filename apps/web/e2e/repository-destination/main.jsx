import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectRepository } from '../../components/project/ProjectRepository.tsx';

const cases = Object.freeze({
  first: 'https://GitHub.com:8443/Arcanada-one/muneral',
  second: 'https://Codeberg.org:9443/Arcanada-one/muneral/mirror',
  rejected: 'https://synthetic-user:synthetic-pass@rejected.example/private/path?token=synthetic',
  missing: null,
});

function Fixture() {
  const [selected, setSelected] = useState('first');
  return (
    <main>
      <h1>Repository destination</h1>
      <nav aria-label="Synthetic repository states">
        <button type="button" onClick={() => setSelected('first')}>First safe destination</button>
        <button type="button" onClick={() => setSelected('second')}>Second safe destination</button>
        <button type="button" onClick={() => setSelected('rejected')}>Rejected destination</button>
        <button type="button" onClick={() => setSelected('missing')}>Missing destination</button>
      </nav>
      <section data-testid="destination-frame" style={{ width: '12rem', maxWidth: 'calc(100vw - 2rem)' }}>
        <ProjectRepository repoUrl={cases[selected]} />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Fixture />);
