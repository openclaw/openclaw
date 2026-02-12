import optparse
import sys
import re
import os
from .diff import htmldiff

description = """\
"""

parser = optparse.OptionParser(
    usage="%prog [OPTIONS] FILE1 FILE2\n"
    "%prog --annotate [OPTIONS] INFO1 FILE1 INFO2 FILE2 ...",
    description=description,
    )

parser.add_option(
    '-o', '--output',
    metavar="FILE",
    dest="output",
    default="-",
    help="File to write the difference to",
    )

parser.add_option(
    '-a', '--annotation',
    action="store_true",
    dest="annotation",
    help="Do an annotation")

def main(args=None):
    if args is None:
        args = sys.argv[1:]
    options, args = parser.parse_args(args)
    if options.annotation:
        return annotate(options, args)
    if len(args) != 2:
        print('Error: you must give two files')
        parser.print_help()
        sys.exit(1)
    file1, file2 = args
    input1 = read_file(file1)
    input2 = read_file(file2)
    body1 = split_body(input1)[1]
    pre, body2, post = split_body(input2)
    result = htmldiff(body1, body2)
    result = pre + result + post
    if options.output == '-':
        if not result.endswith('\n'):
            result += '\n'
        sys.stdout.write(result)
    else:
        with open(options.output, 'wb') as f:
            f.write(result)

def read_file(filename):
    if filename == '-':
        c = sys.stdin.read()
    elif not os.path.exists(filename):
        raise OSError(
            "Input file %s does not exist" % filename)
    else:
        with open(filename, 'rb') as f:
            c = f.read()
    return c

body_start_re = re.compile(
    r"<body.*?>", re.I|re.S)
body_end_re = re.compile(
    r"</body.*?>", re.I|re.S)
    
def split_body(html):
    pre = post = ''
    match = body_start_re.search(html)
    if match:
        pre = html[:match.end()]
        html = html[match.end():]
    match = body_end_re.search(html)
    if match:
        post = html[match.start():]
        html = html[:match.start()]
    return pre, html, post

def annotate(options, args):
    print("Not yet implemented")
    sys.exit(1)
    
