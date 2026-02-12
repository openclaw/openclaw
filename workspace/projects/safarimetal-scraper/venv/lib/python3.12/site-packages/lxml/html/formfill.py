from lxml.etree import XPath, ElementBase
from lxml.html import fromstring, XHTML_NAMESPACE
from lxml.html import _forms_xpath, _options_xpath, _nons, _transform_result
from lxml.html import defs
import copy

try:
    basestring
except NameError:
    # Python 3
    basestring = str

__all__ = ['FormNotFound', 'fill_form', 'fill_form_html',
           'insert_errors', 'insert_errors_html',
           'DefaultErrorCreator']

class FormNotFound(LookupError):
    """
    Raised when no form can be found
    """

_form_name_xpath = XPath('descendant-or-self::form[name=$name]|descendant-or-self::x:form[name=$name]', namespaces={'x':XHTML_NAMESPACE})
_input_xpath = XPath('|'.join(['descendant-or-self::'+_tag for _tag in ('input','select','textarea','x:input','x:select','x:textarea')]),
                               namespaces={'x':XHTML_NAMESPACE})
_label_for_xpath = XPath('//label[@for=$for_id]|//x:label[@for=$for_id]',
                               namespaces={'x':XHTML_NAMESPACE})
_name_xpath = XPath('descendant-or-self::*[@name=$name]')

def fill_form(
    el,
    values,
    form_id=None,
    form_index=None,
    ):
    el = _find_form(el, form_id=form_id, form_index=form_index)
    _fill_form(el, values)

def fill_form_html(html, values, form_id=None, form_index=None):
    result_type = type(html)
    if isinstance(html, basestring):
        doc = fromstring(html)
    else:
        doc = copy.deepcopy(html)
    fill_form(doc, values, form_id=form_id, form_index=form_index)
    return _transform_result(result_type, doc)

def _fill_form(el, values):
    counts = {}
    if hasattr(values, 'mixed'):
        # For Paste request parameters
        values = values.mixed()
    inputs = _input_xpath(el)
    for input in inputs:
        name = input.get('name')
        if not name:
            continue
        if _takes_multiple(input):
            value = values.get(name, [])
            if not isinstance(value, (list, tuple)):
                value = [value]
            _fill_multiple(input, value)
        elif name not in values:
            continue
        else:
            index = counts.get(name, 0)
            counts[name] = index + 1
            value = values[name]
            if isinstance(value, (list, tuple)):
                try:
                    value = value[index]
                except IndexError:
                    continue
            elif index > 0:
                continue
            _fill_single(input, value)

def _takes_multiple(input):
    if _nons(input.tag) == 'select' and input.get('multiple'):
        # FIXME: multiple="0"?
        return True
    type = input.get('type', '').lower()
    if type in ('radio', 'checkbox'):
        return True
    return False

def _fill_multiple(input, value):
    type = input.get('type', '').lower()
    if type == 'checkbox':
        v = input.get('value')
        if v is None:
            if not value:
                result = False
            else:
                result = value[0]
                if isinstance(value, basestring):
                    # The only valid "on" value for an unnamed checkbox is 'on'
                    result = result == 'on'
            _check(input, result)
        else:
            _check(input, v in value)
    elif type == 'radio':
        v = input.get('value')
        _check(input, v in value)
    else:
        assert _nons(input.tag) == 'select'
        for option in _options_xpath(input):
            v = option.get('value')
            if v is None:
                # This seems to be the default, at least on IE
                # FIXME: but I'm not sure
                v = option.text_content()
            _select(option, v in value)

def _check(el, check):
    if check:
        el.set('checked', '')
    else:
        if 'checked' in el.attrib:
            del el.attrib['checked']

def _select(el, select):
    if select:
        el.set('selected', '')
    else:
        if 'selected' in el.attrib:
            del el.attrib['selected']

def _fill_single(input, value):
    if _nons(input.tag) == 'textarea':
        input.text = value
    else:
        input.set('value', value)

def _find_form(el, form_id=None, form_index=None):
    if form_id is None and form_index is None:
        forms = _forms_xpath(el)
        for form in forms:
            return form
        raise FormNotFound(
            "No forms in page")
    if form_id is not None:
        form = el.get_element_by_id(form_id)
        if form is not None:
            return form
        forms = _form_name_xpath(el, name=form_id)
        if forms:
            return forms[0]
        else:
            raise FormNotFound(
                "No form with the name or id of %r (forms: %s)"
                % (id, ', '.join(_find_form_ids(el))))               
    if form_index is not None:
        forms = _forms_xpath(el)
        try:
            return forms[form_index]
        except IndexError:
            raise FormNotFound(
                "There is no form with the index %r (%i forms found)"
                % (form_index, len(forms)))

def _find_form_ids(el):
    forms = _forms_xpath(el)
    if not forms:
        yield '(no forms)'
        return
    for index, form in enumerate(forms):
        if form.get('id'):
            if form.get('name'):
                yield '%s or %s' % (form.get('id'),
                                     form.get('name'))
            else:
                yield form.get('id')
        elif form.get('name'):
            yield form.get('name')
        else:
            yield '(unnamed form %s)' % index

############################################################
## Error filling
############################################################

class DefaultErrorCreator:
    insert_before = True
    block_inside = True
    error_container_tag = 'div'
    error_message_class = 'error-message'
    error_block_class = 'error-block'
    default_message = "Invalid"

    def __init__(self, **kw):
        for name, value in kw.items():
            if not hasattr(self, name):
                raise TypeError(
                    "Unexpected keyword argument: %s" % name)
            setattr(self, name, value)

    def __call__(self, el, is_block, message):
        error_el = el.makeelement(self.error_container_tag)
        if self.error_message_class:
            error_el.set('class', self.error_message_class)
        if is_block and self.error_block_class:
            error_el.set('class', error_el.get('class', '')+' '+self.error_block_class)
        if message is None or message == '':
            message = self.default_message
        if isinstance(message, ElementBase):
            error_el.append(message)
        else:
            assert isinstance(message, basestring), (
                "Bad message; should be a string or element: %r" % message)
            error_el.text = message or self.default_message
        if is_block and self.block_inside:
            if self.insert_before:
                error_el.tail = el.text
                el.text = None
                el.insert(0, error_el)
            else:
                el.append(error_el)
        else:
            parent = el.getparent()
            pos = parent.index(el)
            if self.insert_before:
                parent.insert(pos, error_el)
            else:
                error_el.tail = el.tail
                el.tail = None
                parent.insert(pos+1, error_el)

default_error_creator = DefaultErrorCreator()
    

def insert_errors(
    el,
    errors,
    form_id=None,
    form_index=None,
    error_class="error",
    error_creator=default_error_creator,
    ):
    el = _find_form(el, form_id=form_id, form_index=form_index)
    for name, error in errors.items():
        if error is None:
            continue
        for error_el, message in _find_elements_for_name(el, name, error):
            assert isinstance(message, (basestring, type(None), ElementBase)), (
                "Bad message: %r" % message)
            _insert_error(error_el, message, error_class, error_creator)

def insert_errors_html(html, values, **kw):
    result_type = type(html)
    if isinstance(html, basestring):
        doc = fromstring(html)
    else:
        doc = copy.deepcopy(html)
    insert_errors(doc, values, **kw)
    return _transform_result(result_type, doc)

def _insert_error(el, error, error_class, error_creator):
    if _nons(el.tag) in defs.empty_tags or _nons(el.tag) == 'textarea':
        is_block = False
    else:
        is_block = True
    if _nons(el.tag) != 'form' and error_class:
        _add_class(el, error_class)
    if el.get('id'):
        labels = _label_for_xpath(el, for_id=el.get('id'))
        if labels:
            for label in labels:
                _add_class(label, error_class)
    error_creator(el, is_block, error)

def _add_class(el, class_name):
    if el.get('class'):
        el.set('class', el.get('class')+' '+class_name)
    else:
        el.set('class', class_name)

def _find_elements_for_name(form, name, error):
    if name is None:
        # An error for the entire form
        yield form, error
        return
    if name.startswith('#'):
        # By id
        el = form.get_element_by_id(name[1:])
        if el is not None:
            yield el, error
        return
    els = _name_xpath(form, name=name)
    if not els:
        # FIXME: should this raise an exception?
        return
    if not isinstance(error, (list, tuple)):
        yield els[0], error
        return
    # FIXME: if error is longer than els, should it raise an error?
    for el, err in zip(els, error):
        if err is None:
            continue
        yield el, err
