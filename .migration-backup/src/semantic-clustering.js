function tokenize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3)
    .filter(word => !['with', 'from', 'that', 'this', 'have', 'will', 'been', 'into', 'over', 'after', 'before', 'about'].includes(word));
}

function jaccard(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(item => setB.has(item)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function storyText(story = {}) {
  return [story.title, story.summary, story.articleText, story.category].filter(Boolean).join(' ');
}

function hasSharedOperationalEntity(a = {}, b = {}) {
  const entityPattern = /(norwegian|ncl|royal caribbean|carnival|msc|miami|galveston|tampa|canaveral|fort lauderdale|nassau|cozumel|bermuda|san juan|faa|hurricane|storm|airport|port)/gi;
  const aEntities = new Set((storyText(a).match(entityPattern) || []).map(item => item.toLowerCase()));
  const bEntities = new Set((storyText(b).match(entityPattern) || []).map(item => item.toLowerCase()));
  return [...aEntities].some(entity => bEntities.has(entity));
}

function shouldCluster(a = {}, b = {}) {
  const similarity = jaccard(tokenize(storyText(a)), tokenize(storyText(b)));
  return similarity >= 0.34 || (similarity >= 0.22 && hasSharedOperationalEntity(a, b));
}

function clusterStories(stories = []) {
  const clusters = [];

  for (const story of stories) {
    const existing = clusters.find(cluster => cluster.items.some(item => shouldCluster(item, story)));
    if (existing) existing.items.push(story);
    else clusters.push({ id: `cluster-${clusters.length + 1}`, items: [story] });
  }

  return clusters.map(cluster => {
    const representative = cluster.items.find(item => item.trustLevel?.startsWith('high')) || cluster.items[0];
    const sources = [...new Set(cluster.items.flatMap(item => item.source ? [item.source] : []))];
    return { ...cluster, representative, sources, duplicateCount: Math.max(0, cluster.items.length - 1) };
  });
}

function flattenRepresentativeStories(clusters = []) {
  return clusters.map(cluster => ({
    ...cluster.representative,
    clusterId: cluster.id,
    duplicateCount: cluster.duplicateCount,
    clusteredSources: cluster.sources,
    relatedStories: cluster.items.map(item => ({ id: item.id, title: item.title, source: item.source, link: item.link }))
  }));
}

module.exports = { clusterStories, flattenRepresentativeStories, shouldCluster };
