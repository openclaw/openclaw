export default function parsePriceString(price) {
  return price ? price.toLocaleString('zh-TW') : '--';
}
