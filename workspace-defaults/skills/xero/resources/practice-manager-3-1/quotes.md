# Quotes

| Endpoint | Description |
| --- | --- |
| GET current | Return a list of current quotes |
| [GET get/\[quote number\]](https://developer.xero.com/documentation/api/practice-manager-3-1/quotes#get-getquote-number) | Detailed information for a specific quote |
| GET draft | Return a list of draft quotes |
| GET list | Return a list of current and archived quotes |

## GET current


Return a list of current quotes

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information on quote. See GET get/\[quote number\] method for example of detailed quote response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/quote.api/current
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Quotes>
    <Quote>
      <ID>Q000123</ID>
      <Type>Estimate</Type>
      <State>Issued</State>
      <Name>Name</Name>
      <Description>Description</Description>
      <Budget />
      <OptionExplanation />
      <Date>2007-09-15T00:00:00</Date>
      <ValidDate>2007-09-22T00:00:00</ValidDate>
      <EstimatedCost>100.00</EstimatedCost>
      <EstimatedCostTax>12.50</EstimatedCostTax>
      <EstimatedCostIncludingTax>112.50</EstimatedCostIncludingTax>
      <Amount>200.00</Amount>
      <AmountTax>25.00</AmountTax>
      <AmountIncludingTax>225.00</AmountIncludingTax>
      <Client>
        <UUID>08bc17b1-9a5c-43b4-93ec-c06939a5e2f8</UUID>
        <Name>A C Smith Limited</Name>
      </Client>
      <Contact>
        <UUID>12bfb338-81e0-4488-8585-626f03eec08e</UUID>
        <Name>Andrew Smith</Name>
      </Contact>
    </Quote>
  </Quotes>
</Response>
```


## GET get/\[quote number\]


Detailed information for a specific quote

### Example URL

```
https://api.xero.com/practicemanager/3.1/quote.api/get/Q000123
```


### Example Quote Response

```
<Response>
  <Status>OK</Status>
  <Quote>
    <ID>Q000123</ID>
    <Type>Estimate</Type>
    <State>Issued</State>
    <Name>Name</Name>
    <Description>Description</Description>
    <Budget />
    <OptionExplanation />
    <Date>2007-09-15T00:00:00</Date>
    <ValidDate>2007-09-22T00:00:00</ValidDate>
    <EstimatedCost>100.00</EstimatedCost>
    <EstimatedCostTax>12.50</EstimatedCostTax>
    <EstimatedCostIncludingTax>112.50</EstimatedCostIncludingTax>
    <Amount>200.00</Amount>
    <AmountTax>25.00</AmountTax>
    <AmountIncludingTax>225.00</AmountIncludingTax>
    <Client>
      <UUID>08bc17b1-9a5c-43b4-93ec-c06939a5e2f8</UUID>
      <Name>A C Smith Limited</Name>
    </Client>
    <Contact>
      <UUID>12bfb338-81e0-4488-8585-626f03eec08e</UUID>
      <Name>Andrew Smith</Name>
    </Contact>
    <Tasks>
      <Task>
        <Name>Design</Name>
        <Description></Description>
        <EstimatedMinutes>60</EstimatedMinutes>
        <BillableRate>150</BillableRate>
        <Billable>Yes</Billable>
        <Amount>150.00</Amount>
        <AmountTax>18.75</AmountTax>
        <AmountIncludingTax>168.75</AmountIncludingTax>
      </Task>
    </Tasks>
    <Costs>
      <Cost>
        <Description>Courier</Description>
        <Note>Note</Note>
        <Code>COURIER</Code>
        <Billable>Yes</Billable>
        <Quantity>1</Quantity>
        <UnitCost>50.00</UnitCost>
        <UnitPrice>50.00</UnitPrice>
        <Amount>50.00</Amount>
        <AmountTax>6.25</AmountTax>
        <AmountIncludingTax>56.25</AmountIncludingTax>
      </Cost>
    </Costs>
    <Options>
      <Option>
        <Description>Printing</Description>
        <Note>Note</Note>
        <Code>PRINT</Code>
        <Quantity>1</Quantity>
        <UnitCost>50.00</UnitCost>
        <UnitPrice>100.00</UnitPrice>
        <Amount>100.00</Amount>
        <AmountTax>12.50</AmountTax>
        <AmountIncludingTax>112.50</AmountIncludingTax>
      </Option>
    </Options>
  </Quote>
</Response>
```


## GET draft


Return a list of draft quotes

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| detailed=true | Optional | Return detailed information on quote. See GET get/\[quote number\] method for example of detailed quote response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/quote.api/draft
```


## GET list


Return a list of current and archived quotes. The maximum date range between the from and to parameters is one year

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| from=YYYYMMDD | Required | Return quotes created on or after this date. |
| to=YYYYMMDD | Required | Return quote created on or before this date. |
| detailed=true | Optional | Return detailed information on quote. See GET get/\[get number\] method for example of detailed quote response. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/quote.api/list?from=20090801&to=20090901
```
