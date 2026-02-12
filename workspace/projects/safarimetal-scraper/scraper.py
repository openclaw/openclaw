#!/usr/bin/env python3
"""
Safari Metal Website Scraper
爬取 https://safarimetal.com/ 的内容
"""

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import os
import json
import time
from pathlib import Path

class SafariMetalScraper:
    def __init__(self, base_url="https://safarimetal.com/"):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        self.visited = set()
        self.output_dir = Path("output")
        self.output_dir.mkdir(exist_ok=True)
        
    def fetch_page(self, url):
        """获取页面内容"""
        try:
            resp = self.session.get(url, timeout=30)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            print(f"Error fetching {url}: {e}")
            return None
    
    def parse_page(self, html, url):
        """解析页面，提取信息"""
        soup = BeautifulSoup(html, 'html.parser')
        
        # 提取页面信息
        data = {
            'url': url,
            'title': soup.title.string if soup.title else '',
            'meta_description': '',
            'headings': [],
            'paragraphs': [],
            'images': [],
            'links': []
        }
        
        # Meta description
        meta = soup.find('meta', attrs={'name': 'description'})
        if meta:
            data['meta_description'] = meta.get('content', '')
        
        # Headings
        for tag in ['h1', 'h2', 'h3']:
            for h in soup.find_all(tag):
                data['headings'].append({'tag': tag, 'text': h.get_text(strip=True)})
        
        # Paragraphs
        for p in soup.find_all('p'):
            text = p.get_text(strip=True)
            if text:
                data['paragraphs'].append(text)
        
        # Images
        for img in soup.find_all('img'):
            src = img.get('src', '')
            if src:
                data['images'].append({
                    'src': urljoin(url, src),
                    'alt': img.get('alt', '')
                })
        
        # Internal links
        for a in soup.find_all('a', href=True):
            href = a['href']
            full_url = urljoin(url, href)
            if urlparse(full_url).netloc == urlparse(self.base_url).netloc:
                data['links'].append(full_url)
        
        return data
    
    def download_image(self, url, folder="images"):
        """下载图片"""
        img_dir = self.output_dir / folder
        img_dir.mkdir(exist_ok=True)
        
        try:
            resp = self.session.get(url, timeout=30)
            resp.raise_for_status()
            
            filename = os.path.basename(urlparse(url).path)
            if not filename:
                filename = f"image_{hash(url)}.jpg"
            
            filepath = img_dir / filename
            with open(filepath, 'wb') as f:
                f.write(resp.content)
            
            print(f"Downloaded: {filename}")
            return str(filepath)
        except Exception as e:
            print(f"Error downloading {url}: {e}")
            return None
    
    def crawl(self, max_pages=50):
        """爬取整个网站"""
        to_visit = [self.base_url]
        all_data = []
        
        while to_visit and len(self.visited) < max_pages:
            url = to_visit.pop(0)
            
            if url in self.visited:
                continue
            
            print(f"Crawling: {url}")
            self.visited.add(url)
            
            html = self.fetch_page(url)
            if not html:
                continue
            
            data = self.parse_page(html, url)
            all_data.append(data)
            
            # 添加新链接
            for link in data['links']:
                if link not in self.visited and link not in to_visit:
                    to_visit.append(link)
            
            time.sleep(1)  # 礼貌爬取
        
        # 保存结果
        output_file = self.output_dir / "scraped_data.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(all_data, f, indent=2, ensure_ascii=False)
        
        print(f"\n爬取完成! 共 {len(all_data)} 页")
        print(f"数据保存至: {output_file}")
        
        return all_data
    
    def download_all_images(self, data):
        """下载所有图片"""
        all_images = set()
        for page in data:
            for img in page.get('images', []):
                all_images.add(img['src'])
        
        print(f"\n下载 {len(all_images)} 张图片...")
        for img_url in all_images:
            self.download_image(img_url)


if __name__ == "__main__":
    scraper = SafariMetalScraper()
    
    # 爬取网站
    data = scraper.crawl(max_pages=30)
    
    # 下载图片
    scraper.download_all_images(data)
    
    print("\n完成!")
