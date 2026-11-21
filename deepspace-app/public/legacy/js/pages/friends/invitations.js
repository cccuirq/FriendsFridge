// Revalidate all visible pages so background updates do not collapse "Load more".
export async function invitationPages(api, path, offset, count, isCurrent) {
  const rows = [];
  let lastOffset = offset;
  let page;
  do {
    page = await api(path + (path.includes('?') ? '&' : '?') + 'offset=' + lastOffset);
    if (!isCurrent()) return null;
    rows.push(...page);
    if (page.length < 20 || rows.length >= count) break;
    lastOffset += 20;
  } while (true);
  return { rows, lastOffset, hasMore: page.length === 20 };
}
