import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickNavigation,
  dataDir,
  openMobileSidebar,
  recruitmentPage,
  seedConfirmedTeams,
  seedDraftMergeTeams,
  seedDraftRecoveryTeams,
  seedTeamTemplateSource,
  sidebarLocator,
} from './team-recruitment-fixtures.mjs';

test.describe('团队招募核心流程', () => {
  test('保存团队模板并创建独立副本，重新确认身份和边界', async ({ page }) => {
    const { source } = seedTeamTemplateSource();
    await page.goto('/');
    await openMobileSidebar(page);
    const sourceNav = sidebarLocator(page)
      .locator('button')
      .filter({ hasText: source.name })
      .first();
    await expect(sourceNav).toBeVisible();
    await sourceNav.click({ force: true });
    await expect(
      page.getByRole('heading', { name: source.name }),
    ).toBeVisible();
    await clickNavigation(page, '团队动态');
    await page.getByRole('button', { name: '保存为模板', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '保存团队模板', exact: true }),
    ).toBeVisible();
    const templateName = `研发模板 ${Date.now()}`;
    await page
      .getByRole('textbox', { name: '模板名称', exact: true })
      .fill(templateName);
    await page.getByRole('button', { name: '保存模板', exact: true }).click();
    await expect(
      page.getByText(`团队“${source.name}”已保存为模板`, { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: '新建团队', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '手动创建团队', exact: true }),
    ).toBeVisible();
    const templatePicker = page.getByRole('combobox', {
      name: '选择团队模板',
      exact: true,
    });
    await expect(templatePicker).toBeVisible();
    await templatePicker.selectOption({ label: templateName });
    const copyName = `支付交付团队 ${Date.now()}`;
    const copyGoal = '负责支付链路的开发、测试和上线。';
    await page
      .getByRole('textbox', { name: '团队名称', exact: true })
      .fill(copyName);
    await page
      .getByRole('textbox', { name: '团队职责 / 目标', exact: true })
      .fill(copyGoal);
    await page
      .getByRole('textbox', { name: '工作目录', exact: true })
      .fill(process.cwd());
    await page.getByRole('button', { name: '创建团队', exact: true }).click();
    await expect(
      page.getByText(new RegExp(`已从模板创建团队“${copyName}`)),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: copyName })).toBeVisible();

    const copied = await page.evaluate(async (name) => {
      const teams = await fetch('/api/teams').then((response) =>
        response.json(),
      );
      const team = teams.find((item) => item.name === name);
      const detail = await fetch(`/api/teams/${team.id}`).then((response) =>
        response.json(),
      );
      return { team, detail };
    }, copyName);
    expect(copied.team).toMatchObject({
      name: copyName,
      goal: copyGoal,
      model: 'template-model',
      providerId: 'template-provider',
    });
    expect(copied.team.memberRoleIds).toEqual(['project_manager', 'developer']);
    expect(copied.team.memberSettings.developer.label).toBe('主开发');
    expect(copied.team.collaboration.allowedTeamIds).toEqual([]);
    expect(copied.detail.messages).toEqual([]);
    expect(copied.detail.tasks).toEqual([]);
  });

  test('招募页面显示可跨设备继续的会话同步状态', async ({ page }) => {
    await recruitmentPage(page);
    await expect(
      page.getByText('招募会话已同步，可在其他设备继续', { exact: true }),
    ).toBeVisible();
  });

  test('草稿跨页面恢复，发布新需求不会复用旧草稿', async ({ page }) => {
    const composer = await recruitmentPage(page);
    const draft = '为开发团队建立一条可验收的交付流程';
    await composer.fill(draft);

    await clickNavigation(page, '助手与模型');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    await clickNavigation(page, '团队招募');
    await expect(composer).toHaveValue(draft);

    await page.getByRole('button', { name: '另起需求', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '发布需求，招募团队' }),
    ).toBeVisible();
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      '',
    );

    const cachedDrafts = await page.evaluate(() => {
      const raw = window.localStorage.getItem('ggb.composer-drafts.v1');
      return raw ? Object.values(JSON.parse(raw).drafts || {}) : [];
    });
    expect(cachedDrafts).toContain(draft);
  });

  test('服务端草稿可跨刷新恢复，并按团队保持隔离', async ({ page }) => {
    const teams = seedDraftRecoveryTeams();
    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page)
        .locator('button')
        .filter({ hasText: team.name })
        .first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(
        page.getByRole('heading', { name: team.name }),
      ).toBeVisible();
    };
    const readDraft = (team) =>
      page.evaluate(
        async ({ spaceId }) => {
          const response = await fetch(
            `/api/drafts?spaceId=${encodeURIComponent(spaceId)}&role=project_manager`,
          );
          return { status: response.status, body: await response.json() };
        },
        { spaceId: team.id },
      );

    await page.goto('/');
    await openTeam(teams.alpha);
    const alphaComposer = page.locator('textarea[aria-label^="发送给"]');
    const alphaDraft = `服务端恢复草稿 ${Date.now()}`;
    await alphaComposer.fill(alphaDraft);
    await expect
      .poll(async () => {
        const result = await readDraft(teams.alpha);
        return result.body.content;
      })
      .toBe(alphaDraft);
    const stored = await readDraft(teams.alpha);
    expect(stored).toMatchObject({
      status: 200,
      body: { content: alphaDraft, roleId: 'project_manager' },
    });

    // Remove the browser-only copy so a reload proves that the server draft,
    // rather than localStorage, restores the composer.
    await page.evaluate(() =>
      window.localStorage.removeItem('ggb.composer-drafts.v1'),
    );
    await page.reload();
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      alphaDraft,
    );

    await openTeam(teams.beta);
    const betaComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(betaComposer).toHaveValue('');
    const betaDraft = `另一团队草稿 ${Date.now()}`;
    await betaComposer.fill(betaDraft);
    await expect
      .poll(async () => {
        const result = await readDraft(teams.beta);
        return result.body.content;
      })
      .toBe(betaDraft);

    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      alphaDraft,
    );
    const betaRemote = await readDraft(teams.beta);
    expect(betaRemote.body.content).toBe(betaDraft);
  });

  test('多设备草稿会自动合并非重叠修改，并为重叠冲突提供版本选择', async ({
    page,
  }) => {
    const teams = seedDraftMergeTeams();
    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page)
        .locator('button')
        .filter({ hasText: team.name })
        .first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(
        page.getByRole('heading', { name: team.name }),
      ).toBeVisible();
    };
    const readDraft = (team) =>
      page.evaluate(
        async ({ spaceId }) => {
          const response = await fetch(
            `/api/drafts?spaceId=${encodeURIComponent(spaceId)}&role=project_manager`,
          );
          return { status: response.status, body: await response.json() };
        },
        { spaceId: team.id },
      );
    const writeRemoteDraft = (team, revision, content) =>
      page.evaluate(
        async ({ spaceId, revision, content }) => {
          const response = await fetch('/api/drafts', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              spaceId,
              roleId: 'project_manager',
              content,
              attachmentIds: [],
              revision,
            }),
          });
          return { status: response.status, body: await response.json() };
        },
        { spaceId: team.id, revision, content },
      );

    await page.goto('/');
    await openTeam(teams.merge);
    const mergeComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(mergeComposer).toHaveValue(teams.merge.base);
    const mergeInitial = await readDraft(teams.merge);
    expect(mergeInitial).toMatchObject({
      status: 200,
      body: { revision: teams.merge.revision },
    });

    // Device A edits the first line while device B edits the second line. The
    // browser's three-way merge should retain both edits after the 409 retry.
    await mergeComposer.fill('本机标题\n初始正文');
    const remoteMerge = await writeRemoteDraft(
      teams.merge,
      mergeInitial.body.revision,
      '初始标题\n远端正文',
    );
    expect(remoteMerge.status).toBe(200);
    await expect
      .poll(async () => (await readDraft(teams.merge)).body.content, {
        timeout: 15_000,
      })
      .toBe('本机标题\n远端正文');
    await expect(mergeComposer).toHaveValue('本机标题\n远端正文');
    await expect(page.locator('.draft-sync-status')).toContainText(
      '草稿已同步',
    );

    await openTeam(teams.conflict);
    const conflictComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(conflictComposer).toHaveValue(teams.conflict.base);
    const conflictInitial = await readDraft(teams.conflict);
    await conflictComposer.fill('本机版本');
    const remoteConflict = await writeRemoteDraft(
      teams.conflict,
      conflictInitial.body.revision,
      '远端版本',
    );
    expect(remoteConflict.status).toBe(200);

    // Overlapping edits remain visible until the owner chooses which version
    // should win; the UI must never silently discard either device's text.
    const conflictPanel = page
      .getByRole('alert')
      .filter({ hasText: '其他设备' });
    await expect(conflictPanel).toBeVisible({ timeout: 15_000 });
    await expect(conflictPanel).toContainText('本机版本');
    await expect(conflictPanel).toContainText('远端版本');
    await conflictPanel
      .getByRole('button', { name: /使用其他设备版本/ })
      .click();
    await expect(conflictComposer).toHaveValue('远端版本');
    await expect
      .poll(async () => (await readDraft(teams.conflict)).body.content)
      .toBe('远端版本');
    await expect(page.locator('.draft-sync-status')).toContainText(
      '草稿已同步',
    );

    // Exercise the other explicit decision as well: choosing the local copy
    // must retry against the observed remote revision and overwrite it.
    const localChoiceInitial = await readDraft(teams.conflict);
    await conflictComposer.fill('本机覆盖版本');
    const remoteForLocalChoice = await writeRemoteDraft(
      teams.conflict,
      localChoiceInitial.body.revision,
      '远端第二版本',
    );
    expect(remoteForLocalChoice.status).toBe(200);
    const secondConflictPanel = page
      .getByRole('alert')
      .filter({ hasText: '其他设备' });
    await expect(secondConflictPanel).toBeVisible({ timeout: 15_000 });
    await secondConflictPanel
      .getByRole('button', { name: /保留本机并覆盖远端/ })
      .click();
    await expect(conflictComposer).toHaveValue('本机覆盖版本');
    await expect
      .poll(async () => (await readDraft(teams.conflict)).body.content)
      .toBe('本机覆盖版本');
    await expect(page.locator('.draft-sync-status')).toContainText(
      '草稿已同步',
    );
  });

  test('刷新后保留后台任务视图和当前团队上下文', async ({ page }) => {
    const teams = seedConfirmedTeams();
    const team = teams.development;
    await page.goto('/');
    await openMobileSidebar(page);
    const teamNavigation = sidebarLocator(page)
      .locator('button')
      .filter({ hasText: team.name })
      .first();
    await expect(teamNavigation).toBeVisible();
    await teamNavigation.click({ force: true });
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await expect(page.getByText('风险/阻塞', { exact: true })).toBeVisible();
    await expect(
      page.getByText('最近交付证据 0 项', { exact: true }),
    ).toBeVisible();

    await clickNavigation(page, '后台任务');
    await expect(
      page.getByRole('heading', { name: '让工作持续推进。' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem('ggb.workspace-route.v1');
          return raw ? JSON.parse(raw) : null;
        }),
      )
      .toMatchObject({ spaceId: team.id, view: 'tasks' });

    await page.reload();
    await expect(
      page.getByRole('heading', { name: '让工作持续推进。' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem('ggb.workspace-route.v1');
          return raw ? JSON.parse(raw) : null;
        }),
      )
      .toMatchObject({ spaceId: team.id, view: 'tasks' });

    // Switching back to the team view proves the selected team survived the
    // utility-page remount; a reset to the first team would expose a different
    // heading or activity stream here.
    await clickNavigation(page, '团队动态');
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  });

  test('拖入图片保存真实二进制附件，并在需求草稿中显示文件卡片', async ({
    page,
  }) => {
    const composer = await recruitmentPage(page);
    await composer.fill('请识别这张设计图中的交付要求');
    const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3];
    const attachmentDir = path.join(dataDir, 'attachments');
    const existingFiles = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'))
      : [];
    await page.locator('.composer').evaluate((element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], 'design.png', { type: 'image/png' }),
      );
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        element.dispatchEvent(event);
      }
    }, pngBytes);

    await expect(
      page.getByRole('button', { name: /design\.png/ }),
    ).toBeVisible();
    await expect(page.getByText(/已添加 1 个附件/)).toBeVisible();

    await expect
      .poll(() => {
        if (!fs.existsSync(attachmentDir)) return [];
        return fs
          .readdirSync(attachmentDir)
          .filter((name) => name.endsWith('.bin'));
      })
      .toHaveLength(existingFiles.length + 1);
    const currentFiles = fs
      .readdirSync(attachmentDir)
      .filter((name) => name.endsWith('.bin'));
    const newFile = currentFiles.find((name) => !existingFiles.includes(name));
    expect(newFile).toBeTruthy();
    const stored = fs.readFileSync(path.join(attachmentDir, newFile));
    expect([...stored]).toEqual(pngBytes);
  });

  test('手机端保留当前工作上下文并提供触控文件入口，设置使用底部面板', async ({
    page,
  }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    const mobile = (page.viewportSize()?.width || 1024) < 768;
    const context = page.getByTestId('mobile-context-bar');
    if (!mobile) {
      await expect(context).toBeHidden();
      await expect(
        page.getByRole('button', { name: '添加附件', exact: true }),
      ).toBeHidden();
      return;
    }

    await expect(context).toBeVisible();
    await expect(
      context.getByRole('button', { name: '切换团队和工作空间', exact: true }),
    ).toBeVisible();
    await context
      .getByRole('button', { name: '切换团队和工作空间', exact: true })
      .click();
    const switcher = page.getByRole('dialog');
    await expect(switcher).toBeVisible();
    await expect(
      switcher.getByText('切换当前工作', { exact: true }),
    ).toBeVisible();
    const teamSearch = switcher.getByRole('searchbox', {
      name: '搜索我的团队',
      exact: true,
    });
    await expect(teamSearch).toBeVisible();
    await teamSearch.fill(teams.development.name);
    await expect(
      switcher.getByRole('button', {
        name: new RegExp(teams.development.name),
      }),
    ).toBeVisible();
    await expect(
      switcher.getByRole('button', { name: new RegExp(teams.operations.name) }),
    ).toBeHidden();
    await switcher
      .getByRole('button', { name: '清除团队搜索', exact: true })
      .click();
    await switcher
      .getByRole('button', { name: new RegExp(teams.development.name) })
      .click();
    await expect(switcher).toBeHidden({ timeout: 2_000 });
    await expect(context).toContainText(teams.development.name);

    const attachmentButton = page.getByRole('button', {
      name: '添加附件',
      exact: true,
    });
    await expect(attachmentButton).toBeVisible();
    await page
      .locator('input[type="file"][aria-label="选择要添加的文件"]')
      .setInputFiles({
        name: 'mobile-note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('mobile attachment payload'),
      });
    await expect(
      page.getByRole('button', { name: /mobile-note\.txt/ }),
    ).toBeVisible();

    await page.getByRole('button', { name: '团队设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(350);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(
      Math.abs(
        (box?.y || 0) + (box?.height || 0) - (page.viewportSize()?.height || 0),
      ),
    ).toBeLessThan(4);
    await expect(
      dialog.getByRole('button', { name: '保存团队设置', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('手机端主导航可以在招募、团队、任务和更多之间切换', async ({ page }) => {
    seedConfirmedTeams();
    await page.addInitScript(() => window.localStorage.clear());
    const stateLoaded = page.waitForResponse(
      (response) => response.url().includes('/api/state') && response.ok(),
    );
    await page.goto('/');
    await stateLoaded;
    const navigation = page.getByRole('navigation', {
      name: '移动端主导航',
      exact: true,
    });
    const mobile = (page.viewportSize()?.width || 1024) < 768;
    if (!mobile) {
      await expect(navigation).toBeHidden();
      return;
    }

    await expect(navigation).toBeVisible();
    await navigation
      .getByRole('button', { name: '团队', exact: true })
      .click({ force: true });
    await expect(
      page
        .getByRole('heading')
        .filter({ hasText: /团队/ })
        .first(),
    ).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: '团队', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()?.width || 1024);

    await navigation
      .getByRole('button', { name: '任务', exact: true })
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: '让工作持续推进。' }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: '任务', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()?.width || 1024);

    await navigation
      .getByRole('button', { name: '招募', exact: true })
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: '发布需求，招募团队' }),
    ).toBeVisible();
    const recruitmentStatus = page.getByTestId('recruitment-status-card');
    await expect(recruitmentStatus).toContainText('需求草稿');
    await expect(recruitmentStatus).toContainText(/正在澄清|方案待确认/);
    await expect(recruitmentStatus).toContainText(
      /确认后才会(?:进入|创建成员并进入)“我的团队”|信息充分后会生成团队名称/,
    );
    if ((page.viewportSize()?.width || 1024) < 768) {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(page.viewportSize()?.width || 1024);
    }
    await expect(
      navigation.getByRole('button', { name: '招募', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    await navigation
      .getByRole('button', { name: '更多', exact: true })
      .click({ force: true });
    await expect(sidebarLocator(page)).toBeVisible();
    await expect(
      sidebarLocator(page).getByRole('button', {
        name: '关闭导航',
        exact: true,
      }),
    ).toBeVisible();
    await sidebarLocator(page)
      .getByRole('button', { name: '助手与模型', exact: true })
      .click({ force: true });
    await expect(sidebarLocator(page)).toBeHidden();
    await expect(
      navigation.getByRole('button', { name: '更多', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()?.width || 1024);
    await navigation
      .getByRole('button', { name: '更多', exact: true })
      .click({ force: true });
    await expect(sidebarLocator(page)).toBeVisible();
    await sidebarLocator(page)
      .getByRole('button', { name: '关闭导航', exact: true })
      .click();
    await expect(sidebarLocator(page)).toBeHidden();
  });
});
