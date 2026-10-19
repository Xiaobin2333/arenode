import { appState } from './app-state.js';
import { authState } from './auth-state.js';
import { siteState } from './site-state.js';
import { billingState } from './billing-state.js';
import { adminState } from './admin-state.js';
import { monitorState } from './monitor-state.js';
import { resourceState } from './resource-state.js';

export const state = { ...appState, ...authState, ...siteState, ...billingState, ...adminState, ...monitorState, ...resourceState };
