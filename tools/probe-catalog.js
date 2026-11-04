/*
 * 目录探测脚本 —— 用法：
 *   1. 打开智慧树课程播放页；
 *   2. F12 打开 DevTools，切到 Console，整段粘贴回车；
 *   3. 按提示点击左侧目录里**任意一项**；
 *   4. 把 Console 里打印的两段内容复制回来。
 *
 * 目的：拿到目录项真实的标签、类名和层级，用来给扩展写准确的选择器。
 * 如果目录在 iframe 里，在 Console 顶部的下拉框里选中对应 frame 再粘贴。
 */
(() => {
  const tag = (t) =>
    console.log(
      '%c[目录探测]%c ' + t,
      'background:#0ea5e9;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600',
      'color:#0ea5e9'
    );

  tag('已启动：请点击左侧目录里的任意一项（只会触发这一次，不会真的跳转）');

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.removeEventListener('click', handler, true);

    /* 1) 从命中的元素往上 10 层，打印标签与类名 */
    const chain = [];
    let el = e.target;
    for (let i = 0; i < 10 && el && el !== document.documentElement; i += 1) {
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : '';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      chain.push(`${i}. <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}>  "${text}"`);
      el = el.parentElement;
    }
    tag('点击链路（0 = 命中元素，向上递增）：');
    console.log(chain.join('\n'));

    /* 2) 向上 4 层，把整块目录的 HTML 打出来（截断，避免刷屏） */
    let block = e.target;
    for (let i = 0; i < 4 && block.parentElement; i += 1) block = block.parentElement;
    tag('目录容器 HTML（已截断 4000 字符）：');
    console.log(block.outerHTML.slice(0, 4000));

    /* 3) 顺手统计：容器下有多少个结构相同的兄弟节点 */
    const parent = e.target.parentElement;
    if (parent) {
      const sig = [...parent.children].map((c) => c.tagName + '|' + (c.className || ''));
      const counts = {};
      sig.forEach((s) => (counts[s] = (counts[s] || 0) + 1));
      tag('同级条目统计（tag|class → 数量）：');
      console.log(counts);
    }
  };

  document.addEventListener('click', handler, true);
})();
