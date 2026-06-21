import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app')! });

const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
if (themeColorMeta) {
  themeColorMeta.content = getComputedStyle(document.body).backgroundColor;
}
