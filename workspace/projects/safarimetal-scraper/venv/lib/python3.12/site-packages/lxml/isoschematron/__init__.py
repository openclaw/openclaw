"""The ``lxml.isoschematron`` package implements ISO Schematron support on top
of the pure-xslt 'skeleton' implementation.
"""

import sys
import os.path
from lxml import etree as _etree # due to validator __init__ signature


# some compat stuff, borrowed from lxml.html
try:
    unicode
except NameError:
    # Python 3
    unicode = str
try:
    basestring
except NameError:
    # Python 3
    basestring = str


__all__ = ['extract_xsd', 'extract_rng', 'iso_dsdl_include',
           'iso_abstract_expand', 'iso_svrl_for_xslt1',
           'svrl_validation_errors', 'schematron_schema_valid',
           'stylesheet_params', 'Schematron']


# some namespaces
#FIXME: Maybe lxml should provide a dedicated place for common namespace
#FIXME: definitions?
XML_SCHEMA_NS = "http://www.w3.org/2001/XMLSchema"
RELAXNG_NS = "http://relaxng.org/ns/structure/1.0"
SCHEMATRON_NS = "http://purl.oclc.org/dsdl/schematron"
SVRL_NS = "http://purl.oclc.org/dsdl/svrl"


# some helpers
_schematron_root = '{%s}schema' % SCHEMATRON_NS
_xml_schema_root = '{%s}schema' % XML_SCHEMA_NS
_resources_dir = os.path.join(os.path.dirname(__file__), 'resources')


# the iso-schematron skeleton implementation steps aka xsl transformations
extract_xsd = _etree.XSLT(_etree.parse(
    os.path.join(_resources_dir, 'xsl', 'XSD2Schtrn.xsl')))
extract_rng = _etree.XSLT(_etree.parse(
    os.path.join(_resources_dir, 'xsl', 'RNG2Schtrn.xsl')))
iso_dsdl_include = _etree.XSLT(_etree.parse(
    os.path.join(_resources_dir, 'xsl', 'iso-schematron-xslt1',
                 'iso_dsdl_include.xsl')))
iso_abstract_expand = _etree.XSLT(_etree.parse(
    os.path.join(_resources_dir, 'xsl', 'iso-schematron-xslt1',
                 'iso_abstract_expand.xsl')))
iso_svrl_for_xslt1 = _etree.XSLT(_etree.parse(
    os.path.join(_resources_dir,
                 'xsl', 'iso-schematron-xslt1', 'iso_svrl_for_xslt1.xsl')))


# svrl result accessors
svrl_validation_errors = _etree.XPath(
    '//svrl:failed-assert', namespaces={'svrl': SVRL_NS})

# RelaxNG validator for schematron schemas
schematron_schema_valid_supported = False
try:
    schematron_schema_valid = _etree.RelaxNG(
        file=os.path.join(_resources_dir, 'rng', 'iso-schematron.rng'))
    schematron_schema_valid_supported = True
except _etree.RelaxNGParseError:
    # Some distributions delete the file due to licensing issues.
    def schematron_schema_valid(arg):
        raise NotImplementedError("Validating the ISO schematron requires iso-schematron.rng")


def stylesheet_params(**kwargs):
    """Convert keyword args to a dictionary of stylesheet parameters.
    XSL stylesheet parameters must be XPath expressions, i.e.:

    * string expressions, like "'5'"
    * simple (number) expressions, like "5"
    * valid XPath expressions, like "/a/b/text()"

    This function converts native Python keyword arguments to stylesheet
    parameters following these rules:
    If an arg is a string wrap it with XSLT.strparam().
    If an arg is an XPath object use its path string.
    If arg is None raise TypeError.
    Else convert arg to string.
    """
    result = {}
    for key, val in kwargs.items():
        if isinstance(val, basestring):
            val = _etree.XSLT.strparam(val)
        elif val is None:
            raise TypeError('None not allowed as a stylesheet parameter')
        elif not isinstance(val, _etree.XPath):
            val = unicode(val)
        result[key] = val
    return result


# helper function for use in Schematron __init__
def _stylesheet_param_dict(paramsDict, kwargsDict):
    """Return a copy of paramsDict, updated with kwargsDict entries, wrapped as
    stylesheet arguments.
    kwargsDict entries with a value of None are ignored.
    """
    # beware of changing mutable default arg
    paramsDict = dict(paramsDict)
    for k, v in kwargsDict.items():
        if v is not None: # None values do not override
            paramsDict[k] = v
    paramsDict = stylesheet_params(**paramsDict)
    return paramsDict


class Schematron(_etree._Validator):
    """An ISO Schematron validator.

    Pass a root Element or an ElementTree to turn it into a validator.
    Alternatively, pass a filename as keyword argument 'file' to parse from
    the file system.

    Schematron is a less well known, but very powerful schema language.
    The main idea is to use the capabilities of XPath to put restrictions on
    the structure and the content of XML documents.

    The standard behaviour is to fail on ``failed-assert`` findings only
    (``ASSERTS_ONLY``).  To change this, you can either pass a report filter
    function to the ``error_finder`` parameter (e.g. ``ASSERTS_AND_REPORTS``
    or a custom ``XPath`` object), or subclass isoschematron.Schematron for
    complete control of the validation process.

    Built on the Schematron language 'reference' skeleton pure-xslt
    implementation, the validator is created as an XSLT 1.0 stylesheet using
    these steps:

     0) (Extract from XML Schema or RelaxNG schema)
     1) Process inclusions
     2) Process abstract patterns
     3) Compile the schematron schema to XSLT

    The ``include`` and ``expand`` keyword arguments can be used to switch off
    steps 1) and 2).
    To set parameters for steps 1), 2) and 3) hand parameter dictionaries to the
    keyword arguments ``include_params``, ``expand_params`` or
    ``compile_params``.
    For convenience, the compile-step parameter ``phase`` is also exposed as a
    keyword argument ``phase``. This takes precedence if the parameter is also
    given in the parameter dictionary.

    If ``store_schematron`` is set to True, the (included-and-expanded)
    schematron document tree is stored and available through the ``schematron``
    property.
    If ``store_xslt`` is set to True, the validation XSLT document tree will be
    stored and can be retrieved through the ``validator_xslt`` property.
    With ``store_report`` set to True (default: False), the resulting validation
    report document gets stored and can be accessed as the ``validation_report``
    property.

    If ``validate_schema`` is set to False, the validation of the schema file
    itself is disabled.  Validation happens by default after building the full
    schema, unless the schema validation file cannot be found at import time,
    in which case the validation gets disabled.  Some lxml distributions exclude
    this file due to licensing issues.  ISO-Schematron validation can then still
    be used normally, but the schemas themselves cannot be validated.

    Here is a usage example::

      >>> from lxml import etree
      >>> from lxml.isoschematron import Schematron

      >>> schematron = Schematron(etree.XML('''
      ... <schema xmlns="http://purl.oclc.org/dsdl/schematron" >
      ...   <pattern id="id_only_attribute">
      ...     <title>id is the only permitted attribute name</title>
      ...     <rule context="*">
      ...       <report test="@*[not(name()='id')]">Attribute
      ...         <name path="@*[not(name()='id')]"/> is forbidden<name/>
      ...       </report>
      ...     </rule>
      ...   </pattern>
      ... </schema>'''),
      ... error_finder=Schematron.ASSERTS_AND_REPORTS)

      >>> xml = etree.XML('''
      ... <AAA name="aaa">
      ...   <BBB id="bbb"/>
      ...   <CCC color="ccc"/>
      ... </AAA>
      ... ''')

      >>> schematron.validate(xml)
      False

      >>> xml = etree.XML('''
      ... <AAA id="aaa">
      ...   <BBB id="bbb"/>
      ...   <CCC/>
      ... </AAA>
      ... ''')

      >>> schematron.validate(xml)
      True
    """

    # libxml2 error categorization for validation errors
    _domain = _etree.ErrorDomains.SCHEMATRONV
    _level = _etree.ErrorLevels.ERROR
    _error_type = _etree.ErrorTypes.SCHEMATRONV_ASSERT

    # convenience definitions for common behaviours
    ASSERTS_ONLY = svrl_validation_errors  # Default
    ASSERTS_AND_REPORTS = _etree.XPath(
        '//svrl:failed-assert | //svrl:successful-report',
        namespaces={'svrl': SVRL_NS})

    def _extract(self, element):
        """Extract embedded schematron schema from non-schematron host schema.
        This method will only be called by __init__ if the given schema document
        is not a schematron schema by itself.
        Must return a schematron schema document tree or None.
        """
        schematron = None
        if element.tag == _xml_schema_root:
            schematron = self._extract_xsd(element)
        elif element.nsmap.get(element.prefix) == RELAXNG_NS:
            # RelaxNG does not have a single unique root element
            schematron = self._extract_rng(element)
        return schematron

    # customization points
    # etree.XSLT objects that provide the extract, include, expand, compile
    # steps
    _extract_xsd = extract_xsd
    _extract_rng = extract_rng
    _include = iso_dsdl_include
    _expand = iso_abstract_expand
    _compile = iso_svrl_for_xslt1

    # etree.xpath object that determines input document validity when applied to
    # the svrl result report; must return a list of result elements (empty if
    # valid)
    _validation_errors = ASSERTS_ONLY

    def __init__(self, etree=None, file=None, include=True, expand=True,
                 include_params={}, expand_params={}, compile_params={},
                 store_schematron=False, store_xslt=False, store_report=False,
                 phase=None, error_finder=ASSERTS_ONLY,
                 validate_schema=schematron_schema_valid_supported):
        super().__init__()

        self._store_report = store_report
        self._schematron = None
        self._validator_xslt = None
        self._validation_report = None
        if error_finder is not self.ASSERTS_ONLY:
            self._validation_errors = error_finder

        # parse schema document, may be a schematron schema or an XML Schema or
        # a RelaxNG schema with embedded schematron rules
        root = None
        try:
            if etree is not None:
                if _etree.iselement(etree):
                    root = etree
                else:
                    root = etree.getroot()
            elif file is not None:
                root = _etree.parse(file).getroot()
        except Exception:
            raise _etree.SchematronParseError(
                "No tree or file given: %s" % sys.exc_info()[1])
        if root is None:
            raise ValueError("Empty tree")
        if root.tag == _schematron_root:
            schematron = root
        else:
            schematron = self._extract(root)
        if schematron is None:
            raise _etree.SchematronParseError(
                "Document is not a schematron schema or schematron-extractable")
        # perform the iso-schematron skeleton implementation steps to get a
        # validating xslt
        if include:
            schematron = self._include(schematron, **include_params)
        if expand:
            schematron = self._expand(schematron, **expand_params)
        if validate_schema and not schematron_schema_valid(schematron):
            raise _etree.SchematronParseError(
                "invalid schematron schema: %s" %
                schematron_schema_valid.error_log)
        if store_schematron:
            self._schematron = schematron
        # add new compile keyword args here if exposing them
        compile_kwargs = {'phase': phase}
        compile_params = _stylesheet_param_dict(compile_params, compile_kwargs)
        validator_xslt = self._compile(schematron, **compile_params)
        if store_xslt:
            self._validator_xslt = validator_xslt
        self._validator = _etree.XSLT(validator_xslt)

    def __call__(self, etree):
        """Validate doc using Schematron.

        Returns true if document is valid, false if not.
        """
        self._clear_error_log()
        result = self._validator(etree)
        if self._store_report:
            self._validation_report = result
        errors = self._validation_errors(result)
        if errors:
            if _etree.iselement(etree):
                fname = etree.getroottree().docinfo.URL or '<file>'
            else:
                fname = etree.docinfo.URL or '<file>'
            for error in errors:
                # Does svrl report the line number, anywhere? Don't think so.
                self._append_log_message(
                    domain=self._domain, type=self._error_type,
                    level=self._level, line=0,
                    message=_etree.tostring(error, encoding='unicode'),
                    filename=fname)
            return False
        return True

    @property
    def schematron(self):
        """ISO-schematron schema document (None if object has been initialized
        with store_schematron=False).
        """
        return self._schematron

    @property
    def validator_xslt(self):
        """ISO-schematron skeleton implementation XSLT validator document (None
        if object has been initialized with store_xslt=False).
        """
        return self._validator_xslt

    @property
    def validation_report(self):
        """ISO-schematron validation result report (None if result-storing has
        been turned off).
        """
        return self._validation_report
