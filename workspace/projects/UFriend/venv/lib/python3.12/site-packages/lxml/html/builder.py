# --------------------------------------------------------------------
# The ElementTree toolkit is
# Copyright (c) 1999-2004 by Fredrik Lundh
# --------------------------------------------------------------------

"""
A set of HTML generator tags for building HTML documents.

Usage::

    >>> from lxml.html.builder import *
    >>> html = HTML(
    ...            HEAD( TITLE("Hello World") ),
    ...            BODY( CLASS("main"),
    ...                  H1("Hello World !")
    ...            )
    ...        )

    >>> import lxml.etree
    >>> print lxml.etree.tostring(html, pretty_print=True)
    <html>
      <head>
        <title>Hello World</title>
      </head>
      <body class="main">
        <h1>Hello World !</h1>
      </body>
    </html>

"""

from lxml.builder import ElementMaker
from lxml.html import html_parser

E = ElementMaker(makeelement=html_parser.makeelement)

# elements
A = E.a  #: anchor
ABBR = E.abbr  #: abbreviated form (e.g., WWW, HTTP, etc.)
ACRONYM = E.acronym  #: 
ADDRESS = E.address  #: information on author
APPLET = E.applet  #: Java applet (DEPRECATED)
AREA = E.area  #: client-side image map area
ARTICLE = E.article  #: self-contained article
ASIDE = E.aside  #: indirectly-related content
AUDIO = E.audio  #: embedded audio file
B = E.b  #: bold text style
BASE = E.base  #: document base URI
BASEFONT = E.basefont  #: base font size (DEPRECATED)
BDI = E.bdi  #: isolate bidirectional text
BDO = E.bdo  #: I18N BiDi over-ride
BIG = E.big  #: large text style
BLOCKQUOTE = E.blockquote  #: long quotation
BODY = E.body  #: document body
BR = E.br  #: forced line break
BUTTON = E.button  #: push button
CANVAS = E.canvas  #: scriptable graphics container
CAPTION = E.caption  #: table caption
CENTER = E.center  #: shorthand for DIV align=center (DEPRECATED)
CITE = E.cite  #: citation
CODE = E.code  #: computer code fragment
COL = E.col  #: table column
COLGROUP = E.colgroup  #: table column group
DATA = E.data  #: machine-readable translation
DATALIST = E.datalist  #: list of options for an input
DD = E.dd  #: definition description
DEL = getattr(E, 'del')  #: deleted text
DETAILS = E.details  #: expandable section
DFN = E.dfn  #: instance definition
DIALOG = E.dialog  #: dialog box
DIR = E.dir  #: directory list (DEPRECATED)
DIV = E.div  #: generic language/style container
DL = E.dl  #: definition list
DT = E.dt  #: definition term
EM = E.em  #: emphasis
EMBED = E.embed  #: embedded external content
FIELDSET = E.fieldset  #: form control group
FIGCAPTION = E.figcaption  #: figure caption
FIGURE = E.figure  #: self-contained, possibly-captioned content
FONT = E.font  #: local change to font (DEPRECATED)
FOOTER = E.footer  #: footer for nearest ancestor
FORM = E.form  #: interactive form
FRAME = E.frame  #: subwindow
FRAMESET = E.frameset  #: window subdivision
H1 = E.h1  #: heading
H2 = E.h2  #: heading
H3 = E.h3  #: heading
H4 = E.h4  #: heading
H5 = E.h5  #: heading
H6 = E.h6  #: heading
HEAD = E.head  #: document head
HEADER = E.header  #: heading content
HGROUP = E.hgroup  #: heading group
HR = E.hr  #: horizontal rule
HTML = E.html  #: document root element
I = E.i  #: italic text style
IFRAME = E.iframe  #: inline subwindow
IMG = E.img  #: Embedded image
INPUT = E.input  #: form control
INS = E.ins  #: inserted text
ISINDEX = E.isindex  #: single line prompt (DEPRECATED)
KBD = E.kbd  #: text to be entered by the user
LABEL = E.label  #: form field label text
LEGEND = E.legend  #: fieldset legend
LI = E.li  #: list item
LINK = E.link  #: a media-independent link
MAIN = E.main  #: main content
MAP = E.map  #: client-side image map
MARK = E.mark  #: marked/highlighted text
MARQUEE = E.marquee  #: scrolling text
MENU = E.menu  #: menu list (DEPRECATED)
META = E.meta  #: generic metainformation
METER = E.meter  #: numerical value display
NAV = E.nav  #: navigation section
NOBR = E.nobr  #: prevent wrapping
NOFRAMES = E.noframes  #: alternate content container for non frame-based rendering
NOSCRIPT = E.noscript  #: alternate content container for non script-based rendering
OBJECT = E.object  #: generic embedded object
OL = E.ol  #: ordered list
OPTGROUP = E.optgroup  #: option group
OPTION = E.option  #: selectable choice
OUTPUT = E.output  #: result of a calculation
P = E.p  #: paragraph
PARAM = E.param  #: named property value
PICTURE = E.picture  #: picture with multiple sources
PORTAL = E.portal  #: embedded preview
PRE = E.pre  #: preformatted text
PROGRESS = E.progress  #: progress bar
Q = E.q  #: short inline quotation
RB = E.rb  #: ruby base text
RP = E.rp  #: ruby parentheses
RT = E.rt  #: ruby text component
RTC = E.rtc  #: ruby semantic annotation
RUBY = E.ruby  #: ruby annotations
S = E.s  #: strike-through text style (DEPRECATED)
SAMP = E.samp  #: sample program output, scripts, etc.
SCRIPT = E.script  #: script statements
SEARCH = E.search  #: set of form controls for a search
SECTION = E.section  #: generic standalone section
SELECT = E.select  #: option selector
SLOT = E.slot  #: placeholder for JS use
SMALL = E.small  #: small text style
SOURCE = E.source  #: source for picture/audio/video element
SPAN = E.span  #: generic language/style container
STRIKE = E.strike  #: strike-through text (DEPRECATED)
STRONG = E.strong  #: strong emphasis
STYLE = E.style  #: style info
SUB = E.sub  #: subscript
SUMMARY = E.summary  #: summary for <details>
SUP = E.sup  #: superscript
TABLE = E.table  #: 
TBODY = E.tbody  #: table body
TD = E.td  #: table data cell
TEMPLATE = E.template  #: fragment for JS use
TEXTAREA = E.textarea  #: multi-line text field
TFOOT = E.tfoot  #: table footer
TH = E.th  #: table header cell
THEAD = E.thead  #: table header
TIME = E.time  #: date/time
TITLE = E.title  #: document title
TR = E.tr  #: table row
TRACK = E.track  #: audio/video track
TT = E.tt  #: teletype or monospaced text style
U = E.u  #: underlined text style (DEPRECATED)
UL = E.ul  #: unordered list
VAR = E.var  #: instance of a variable or program argument
VIDEO = E.video  #: embedded video file
WBR = E.wbr  #: word break

# attributes (only reserved words are included here)
ATTR = dict
def CLASS(v): return {'class': v}
def FOR(v): return {'for': v}
