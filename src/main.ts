import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { bootstrapBootTheme } from './lib/themes/themes';

async function start(): Promise<void> {
  const boot = await bootstrapBootTheme();
  mount(App, {
    target: document.getElementById('app')!,
    props: {
      initialTheme: boot.theme,
      initialMode: boot.mode,
    },
  });
}

void start();
