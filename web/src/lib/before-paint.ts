import { START } from './start.ts';

/**
 * Which `Reserve`s held nothing the last time they filled in, in this browser, read by a script in the page's head
 * before anything is drawn: what they wait for is fetched by the browser, so the server cannot say.
 */
export const EMPTY = 'sift:empty';

/**
 * The script. Ids are a part's own (`rule-use`), so only letters and hyphens are taken. The installed app's start
 * (`?start=1`) goes where this browser last knew it should (`START`), or, not knowing, is left to the page.
 */
export const BEFORE_PAINT = `try{if(location.pathname==='/'&&location.search==='?start=1'){var t=localStorage.getItem('${START}');if(t==='/inbox')location.replace(t);else if(t==='/')history.replaceState(history.state,'','/')}}catch(_){}try{var e=(localStorage.getItem('${EMPTY}')||'').split(',').filter(function(i){return /^[a-z-]+$/.test(i)});if(e.length){var s=document.createElement('style');s.textContent=e.map(function(i){return '[data-room="'+i+'"]{min-height:0}'}).join('');document.head.appendChild(s)}}catch(_){}`;
