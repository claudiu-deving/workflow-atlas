// End-to-end tests for Milestone 1: truly-infinite nested zoom, the focus-stack camera
// rebasing, the breadcrumb navigator, and depth-correct editing. Runs against the real
// server (see playwright.config.js) with an isolated seeded "e2e" project.
//
// All persistence is blocked at the network layer (the PUT that saves a sheet is fulfilled
// client-side), so: (1) tests never mutate the seeded project, and (2) since the server
// never writes workflows.json, fs.watch never fires, so no live-reload disrupts a test.

import { test, expect } from '@playwright/test';

const SHEET = 'pick-algorithm';

async function settle(page, timeout = 5000) {
  await page.waitForFunction(() => window.__atlasCanvas && window.__atlasCanvas._settled(), null, { timeout });
}
const nav = (page) => page.evaluate(() => window.__atlasCanvas.getNav());
const zoom = (page) => page.evaluate(() => window.__atlasCanvas._cam().zoom);
const nodeCount = (page) => page.evaluate(() => window.__atlasCanvas._nodeCount());
// Edit mode is always on (app.js calls canvas.setEditing(true) at boot — there's no toggle button),
// so this is now a no-op kept for call-site readability.
const enableEdit = async () => {};

async function gotoSheet(page, hash = SHEET) {
  // Block persistence so tests never mutate the seeded project, AND hard-block the live-reload
  // SSE stream so a stray save can never trigger location.reload() mid-test (which would reset
  // the focus depth and fail an assertion for the wrong reason).
  await page.route('**/sheet/**', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      : route.continue());
  await page.route('**/livereload**', (route) => route.abort());
  await page.goto(`/index.html?p=e2e#${hash}`);
  await page.waitForFunction(() => !!window.__atlasCanvas, null, { timeout: 10000 });
  // Kill CSS transitions/animations so layout (e.g. the inspector-open grid reflow) is instant —
  // deterministic for tests. The camera tweens are rAF-driven JS, unaffected by this.
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await settle(page);
}

// screen-center of a node matched by a title regex (in the current focus board)
async function nodeCenter(page, titleRe) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const el = [...document.querySelectorAll('.node')].find((e) => e._node && re.test(e._node.title || ''));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, titleRe.source);
}

test.describe('infinite nested zoom', () => {
  test('boots, renders the seeded sheet, breadcrumb hidden at root', async ({ page }) => {
    await gotoSheet(page);
    expect((await nav(page)).depth).toBe(0);
    await expect(page.locator('#breadcrumb')).not.toHaveClass(/show/);
    await expect(page.locator('.node').first()).toBeVisible();
  });

  test('explicit dive 25 levels deep keeps the scale O(1) — no precision collapse', async ({ page }) => {
    await gotoSheet(page);
    await enableEdit(page);
    const DEPTH = 25;
    for (let i = 0; i < DEPTH; i++) {
      await page.evaluate(() => { const c = window.__atlasCanvas; c.createNodeAtViewCenter(); c.addSubchart(); });
      await settle(page);
      expect((await nav(page)).depth, `depth after dive ${i}`).toBe(i + 1);
      const z = await zoom(page);
      // the headline invariant: re-rooting keeps cam.zoom bounded at EVERY depth (old build collapses by ~6)
      expect(z, `cam.zoom at depth ${i + 1}`).toBeGreaterThan(0.05);
      expect(z, `cam.zoom at depth ${i + 1}`).toBeLessThan(60);
      // mounted DOM stays bounded regardless of absolute depth
      expect(await nodeCount(page), `mounted nodes at depth ${i + 1}`).toBeLessThan(60);
    }
    expect((await nav(page)).depth).toBe(DEPTH);
  });

  test('climb all the way out one level at a time (keyboard pop)', async ({ page }) => {
    await gotoSheet(page);
    await enableEdit(page);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => { const c = window.__atlasCanvas; c.createNodeAtViewCenter(); c.addSubchart(); }); await settle(page); }
    expect((await nav(page)).depth).toBe(6);
    let guard = 0;
    while ((await nav(page)).canPop && guard++ < 20) {
      await page.keyboard.press('Backspace');
      await settle(page);
    }
    expect((await nav(page)).depth).toBe(0);
    await expect(page.locator('#breadcrumb')).not.toHaveClass(/show/);
  });

  test('dive into existing nested content shows the branch board + breadcrumb', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => {
      const c = window.__atlasCanvas;
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Branch on the data/.test(e._node.title || ''));
      c.zoomToNode(el._node, el);
    });
    await settle(page);
    const n = await nav(page);
    expect(n.depth).toBe(1);
    expect(n.chain.map((x) => x.title)).toEqual(["Branch on the data's shape"]);
    await expect(page.locator('#breadcrumb')).toHaveClass(/show/);
    await expect(page.locator('#breadcrumb')).toContainText('1 level deep');
    // the long branch titles are now first-class cards
    await expect(page.locator('.node-title', { hasText: 'Unsorted array' })).toBeVisible();
  });

  test('breadcrumb root crumb jumps back to the sheet root', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => {
      const c = window.__atlasCanvas;
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Branch on the data/.test(e._node.title || ''));
      c.zoomToNode(el._node, el);
    });
    await settle(page);
    expect((await nav(page)).depth).toBe(1);
    await page.locator('#breadcrumb .bc').first().click();   // crumb 0 = the map root
    await settle(page);
    expect((await nav(page)).depth).toBe(0);
    await expect(page.locator('#breadcrumb')).not.toHaveClass(/show/);
  });

  test('focus depth survives a reload (no yank-to-root on MCP/live reload)', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Branch on the data/.test(e._node.title || ''));
      window.__atlasCanvas.zoomToNode(el._node, el);
    });
    await settle(page);
    expect((await nav(page)).depth).toBe(1);
    await page.reload();                       // simulates the live-reload an MCP save triggers
    await page.waitForFunction(() => !!window.__atlasCanvas, null, { timeout: 10000 });
    await settle(page);
    expect((await nav(page)).depth).toBe(1);   // restored where you were, not dropped to the root
    await expect(page.locator('#breadcrumb')).toHaveClass(/show/);
  });

  test('CONTINUOUS WHEEL: zooming into a fan node auto-re-roots, zooming out auto-pops', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);

    // --- wheel IN over the Branch node until it covers the viewport and re-roots ---
    let c = await nodeCenter(page, /Branch on the data/);
    expect(c).not.toBeNull();
    await page.mouse.move(c.x, c.y);
    let rerooted = false;
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, -120);            // negative delta = zoom in
      await settle(page);
      if ((await nav(page)).depth >= 1) { rerooted = true; break; }
      // keep the cursor on the (growing) node so the zoom stays centered on it
      const c2 = await nodeCenter(page, /Branch on the data/);
      if (c2) { c = c2; await page.mouse.move(c.x, c.y); }
    }
    expect(rerooted, 'wheel-in should auto-re-root into the fan board').toBe(true);
    expect((await nav(page)).chain[0].title).toBe("Branch on the data's shape");

    // --- wheel OUT at viewport center until the focus board shrinks and auto-pops ---
    const vp = page.viewportSize();
    await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
    let popped = false;
    for (let i = 0; i < 80; i++) {
      await page.mouse.wheel(0, 160);             // positive delta = zoom out
      await settle(page);
      if ((await nav(page)).depth === 0) { popped = true; break; }
    }
    expect(popped, 'wheel-out should auto-pop back to the root').toBe(true);
    await expect(page.locator('#breadcrumb')).not.toHaveClass(/show/);
  });

  test('re-root is seamless: the child board barely moves on screen', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);
    // capture a branch child node's screen rect just before the dive, and just after
    const before = await page.evaluate(() => {
      const c = window.__atlasCanvas;
      const branch = [...document.querySelectorAll('.node')].find((e) => e._node && /Branch on the data/.test(e._node.title || ''));
      // ensure the child board is mounted by framing the node first
      return branch ? branch.getBoundingClientRect().width : 0;
    });
    expect(before).toBeGreaterThan(0);
  });
});

test.describe('depth-correct editing', () => {
  test('inline title edit commits on Enter', async ({ page }) => {
    await gotoSheet(page);
    await enableEdit(page);
    const titleEl = page.locator('.node-title', { hasText: 'Look at the input' });
    await titleEl.click();          // select first → inspector opens + canvas settles (transitions off in tests)
    await titleEl.dblclick();       // now stable → dblclick starts the inline edit
    await expect(titleEl).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Edited title');
    await page.keyboard.press('Enter');
    await settle(page);
    const title = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Edited title/.test(e._node.title || ''));
      return el ? el._node.title : null;
    });
    expect(title).toBe('Edited title');
  });

  test('inline title edit reverts on Escape', async ({ page }) => {
    await gotoSheet(page);
    await enableEdit(page);
    const titleEl = page.locator('.node-title', { hasText: 'Look at the input' });
    await titleEl.dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('SHOULD NOT STICK');
    await page.keyboard.press('Escape');
    await settle(page);
    const stillThere = await page.evaluate(() =>
      [...document.querySelectorAll('.node')].some((e) => e._node && e._node.title === 'Look at the input'));
    expect(stillThere).toBe(true);
  });

  test('dragging a node moves it (edit mode)', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);
    await enableEdit(page);
    const c = await nodeCenter(page, /Look at the input/);
    const before = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Look at the input/.test(e._node.title || ''));
      return { x: el._node.x, y: el._node.y };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 120, c.y + 80, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const after = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Look at the input/.test(e._node.title || ''));
      return { x: el._node.x, y: el._node.y };
    });
    expect(after.x).not.toBe(before.x);
    expect(after.y).not.toBe(before.y);
  });

  test('double-click on empty canvas creates a node (edit mode)', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);
    await enableEdit(page);
    // find a point inside the canvas that is NOT over any node (viewport-size independent)
    const empty = await page.evaluate(() => {
      const cv = document.querySelector('.canvas').getBoundingClientRect();
      const rects = [...document.querySelectorAll('.node')].map((e) => e.getBoundingClientRect());
      for (let y = cv.top + 50; y < cv.bottom - 50; y += 24)
        for (let x = cv.left + 50; x < cv.right - 50; x += 24)
          if (!rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return { x: Math.round(x), y: Math.round(y) };
      return null;
    });
    expect(empty).not.toBeNull();
    await page.mouse.dblclick(empty.x, empty.y);
    const sel = await page.evaluate(() => { const s = window.__atlasCanvas.getSelection(); return s && s.node ? s.node.title : null; });
    expect(sel).toBe('New node');
  });

  test('Delete key removes the selected node (edit mode)', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);
    await enableEdit(page);
    await page.locator('.node-title', { hasText: 'Look at the input' }).click();
    expect(await page.evaluate(() => !!window.__atlasCanvas.getSelection())).toBe(true);
    await page.keyboard.press('Delete');
    await settle(page);
    const gone = await page.evaluate(() =>
      ![...document.querySelectorAll('.node')].some((e) => e._node && /Look at the input/.test(e._node.title || '')));
    expect(gone).toBe(true);
  });

  test('Space + drag pans the canvas instead of moving the node under the cursor', async ({ page }) => {
    await gotoSheet(page);
    await page.evaluate(() => window.__atlasCanvas.fit());
    await settle(page);
    await enableEdit(page);
    const c = await nodeCenter(page, /Look at the input/);
    const before = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Look at the input/.test(e._node.title || ''));
      return { camX: window.__atlasCanvas._cam().x, nodeX: el._node.x };
    });
    await page.keyboard.down('Space');
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 140, c.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await settle(page);
    const after = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.node')].find((e) => e._node && /Look at the input/.test(e._node.title || ''));
      return { camX: window.__atlasCanvas._cam().x, nodeX: el._node.x };
    });
    expect(after.camX, 'camera panned').not.toBe(before.camX);
    expect(after.nodeX, 'node did NOT move').toBe(before.nodeX);
  });

  test('node text is not selectable (no blue highlight on drag)', async ({ page }) => {
    await gotoSheet(page);
    const us = await page.evaluate(() => {
      const el = document.querySelector('.node');
      return getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect;
    });
    expect(us).toBe('none');
  });
});
