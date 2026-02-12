"""
    pygments.styles
    ~~~~~~~~~~~~~~~

    Contains built-in styles.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.plugin import find_plugin_styles
from pip._vendor.pygments.util import ClassNotFound

#: A dictionary of built-in styles, mapping style names to
#: ``'submodule::classname'`` strings.
STYLE_MAP = {
    'default':  'default::DefaultStyle',
    'emacs':    'emacs::EmacsStyle',
    'friendly': 'friendly::FriendlyStyle',
    'friendly_grayscale': 'friendly_grayscale::FriendlyGrayscaleStyle',
    'colorful': 'colorful::ColorfulStyle',
    'autumn':   'autumn::AutumnStyle',
    'murphy':   'murphy::MurphyStyle',
    'manni':    'manni::ManniStyle',
    'material': 'material::MaterialStyle',
    'monokai':  'monokai::MonokaiStyle',
    'perldoc':  'perldoc::PerldocStyle',
    'pastie':   'pastie::PastieStyle',
    'borland':  'borland::BorlandStyle',
    'trac':     'trac::TracStyle',
    'native':   'native::NativeStyle',
    'fruity':   'fruity::FruityStyle',
    'bw':       'bw::BlackWhiteStyle',
    'vim':      'vim::VimStyle',
    'vs':       'vs::VisualStudioStyle',
    'tango':    'tango::TangoStyle',
    'rrt':      'rrt::RrtStyle',
    'xcode':    'xcode::XcodeStyle',
    'igor':     'igor::IgorStyle',
    'paraiso-light': 'paraiso_light::ParaisoLightStyle',
    'paraiso-dark': 'paraiso_dark::ParaisoDarkStyle',
    'lovelace': 'lovelace::LovelaceStyle',
    'algol':    'algol::AlgolStyle',
    'algol_nu': 'algol_nu::Algol_NuStyle',
    'arduino':  'arduino::ArduinoStyle',
    'rainbow_dash': 'rainbow_dash::RainbowDashStyle',
    'abap':     'abap::AbapStyle',
    'solarized-dark': 'solarized::SolarizedDarkStyle',
    'solarized-light': 'solarized::SolarizedLightStyle',
    'sas':         'sas::SasStyle',
    'staroffice' : 'staroffice::StarofficeStyle',
    'stata':       'stata_light::StataLightStyle',
    'stata-light': 'stata_light::StataLightStyle',
    'stata-dark':  'stata_dark::StataDarkStyle',
    'inkpot':      'inkpot::InkPotStyle',
    'zenburn': 'zenburn::ZenburnStyle',
    'gruvbox-dark': 'gruvbox::GruvboxDarkStyle',
    'gruvbox-light': 'gruvbox::GruvboxLightStyle',
    'dracula': 'dracula::DraculaStyle',
    'one-dark': 'onedark::OneDarkStyle',
    'lilypond' : 'lilypond::LilyPondStyle',
    'nord': 'nord::NordStyle',
    'nord-darker': 'nord::NordDarkerStyle',
    'github-dark': 'gh_dark::GhDarkStyle'
}


def get_style_by_name(name):
    """
    Return a style class by its short name. The names of the builtin styles
    are listed in :data:`pygments.styles.STYLE_MAP`.

    Will raise :exc:`pygments.util.ClassNotFound` if no style of that name is
    found.
    """
    if name in STYLE_MAP:
        mod, cls = STYLE_MAP[name].split('::')
        builtin = "yes"
    else:
        for found_name, style in find_plugin_styles():
            if name == found_name:
                return style
        # perhaps it got dropped into our styles package
        builtin = ""
        mod = name
        cls = name.title() + "Style"

    try:
        mod = __import__('pygments.styles.' + mod, None, None, [cls])
    except ImportError:
        raise ClassNotFound("Could not find style module %r" % mod +
                         (builtin and ", though it should be builtin") + ".")
    try:
        return getattr(mod, cls)
    except AttributeError:
        raise ClassNotFound("Could not find style class %r in style module." % cls)


def get_all_styles():
    """Return a generator for all styles by name, both builtin and plugin."""
    yield from STYLE_MAP
    for name, _ in find_plugin_styles():
        yield name
