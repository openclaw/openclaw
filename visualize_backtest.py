import json
 import argparse
 import pandas as pd
 import matplotlib.pyplot as plt
 plt.switch_backend('Agg')
 def build_report(report_json, img_out, md_out):
     with open(report_json, encoding='utf-8') as f:
         rep = json.load(f)
     df = pd.DataFrame(rep['history'])
     df['date'] = pd.to_datetime(df['date'])
     fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8))
     ax1.plot(df['date'], df['portfolio_value'], label='净值', linewidth=2)
     ax1.set_title('净值曲线', fontsize=14)
     ax1.legend()
     ax1.grid(alpha=0.3)
     ax2.fill_between(df['date'], df['drawdown'], color='red', alpha=0.3)
     ax2.set_title('回撤', fontsize=14)
     ax2.grid(alpha=0.3)
     plt.tight_layout()
     plt.savefig(img_out, dpi=200, bbox_inches='tight')
     plt.close()
     md = f"""# KungFuTrader 实战回测报告
 初始资金: {rep['initial_capital']:.0f} 元
 最终资金: {rep['final_capital']:.0f} 元
 年化收益: {rep['annual_return']:.2%}
 最大回撤: {rep['max_drawdown']:.2%}
 夏普比率: {rep['sharpe_ratio']:.2f}
 """
     with open(md_out, 'w', encoding='utf-8') as f:
         f.write(md)
 if __name__ == "__main__":
     parser = argparse.ArgumentParser()
     parser.add_argument("--report", required=True)
     parser.add_argument("--output_image", required=True)
     parser.add_argument("--output_md", required=True)
     args = parser.parse_args()
     build_report(args.report, args.output_image, args.output_md)
