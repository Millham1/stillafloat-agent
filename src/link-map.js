function buildLink(root, code, item) {
  return `${root}/api/story-status?c=${code}&n=${item}`;
}

module.exports = {
  buildLink
};