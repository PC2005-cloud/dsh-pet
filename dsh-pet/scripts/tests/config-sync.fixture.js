import { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx as h } from 'react/jsx-runtime';
import { makePetUI } from '../../src/client/pet.ts';
import { makePetConfigSection, en } from '../../src/client/settings.ts';

const hooks = { h, useState, useEffect, useRef, useCallback };
const Component =
  location.pathname === '/settings' ? makePetConfigSection({ ...hooks, t: (key) => en[key] ?? key }) : makePetUI(hooks);
createRoot(document.getElementById('root')).render(h(Component, {}));
