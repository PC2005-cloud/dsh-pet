import { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetConfigSection, petBridge } from '../../src/client/settings.ts';
import { en } from '../../src/client/settings/locales/en.ts';
import { zh } from '../../src/client/settings/locales/zh.ts';

petBridge.current = window.initialConfig.main.pets;
petBridge.template = petBridge.current[0];
const dictionary = new URLSearchParams(location.search).get('lang') === 'zh' ? zh : en;
const Section = makePetConfigSection(
  {
    h: jsx,
    useState,
    useEffect,
    useRef,
    useCallback,
    t: (key) => dictionary[key] ?? key,
  },
  {},
);
createRoot(document.getElementById('root')).render(jsx(Section, {}));
