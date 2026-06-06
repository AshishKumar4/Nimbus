#!/usr/bin/env bun
// auth/new/hosted-demo-browser-auth - hosted demo auth should redirect
// browser navigations to login while preserving JSON 401s for API callers.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('auth/new/hosted-demo-browser-auth');
const { demoAuthRequiredResponse } = await import('../../../../apps/hosted-demo/src/demo-http.ts');

function request(path, init = {}) {
  return new Request(`https://nimbus.example.com${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
  });
}

const browserPost = demoAuthRequiredResponse(request('/new', {
  method: 'POST',
  headers: {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  },
}), '/new');
a.check('browser POST /new redirects to login',
  browserPost.status === 303
  && new URL(browserPost.headers.get('Location')).pathname === '/login'
  && new URL(browserPost.headers.get('Location')).searchParams.get('return_to') === '/new',
  `${browserPost.status} ${browserPost.headers.get('Location')}`);

const browserGet = demoAuthRequiredResponse(request('/s/demo-session/', {
  headers: { Accept: 'text/html' },
}), '/s/demo-session/');
a.check('browser GET redirects to login',
  browserGet.status === 302
  && new URL(browserGet.headers.get('Location')).pathname === '/login'
  && new URL(browserGet.headers.get('Location')).searchParams.get('return_to') === '/s/demo-session/',
  `${browserGet.status} ${browserGet.headers.get('Location')}`);

const apiPost = demoAuthRequiredResponse(request('/new', {
  method: 'POST',
  headers: { Accept: 'application/json' },
}), '/new');
const apiJson = await apiPost.json();
a.check('API POST /new keeps JSON login error',
  apiPost.status === 401 && apiJson.code === 'E_DEMO_LOGIN_REQUIRED',
  `${apiPost.status} ${JSON.stringify(apiJson)}`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
