// Chora's own page (chora.html): Chora mounted on a page of its own, with that page's masthead (the way
// back to the main page), its footer and its Permissions panel.
import { mountChora } from './app.js';

mountChora(document.getElementById('chora-root'), { standalone: true });
