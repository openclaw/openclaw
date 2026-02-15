# Costs

| Endpoint | Description |
| --- | --- |
| GET list | Return a list of all costs |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/costs#get-getuuid) | Detailed information for a specific cost |
| POST add | Add a cost |
| PUT update | Update a cost |
| POST delete | Delete a cost |
| POST delete all | Delete all costs |

## GET list


Return a list of all costs

### Parameters

| Parameter | Required? | Description |
| --- | --- | --- |
| page | Required | A maximum of 1000 cost items will be returned per request. The number of items returned will be indicated by the "Records" element. To fetch all the costs you will need to make multiple calls to the API with the page number incremented each time. When the "Records" element is set to 0 then all the costs have been returned. |

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/list?page=1
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Records>2</Records>
  <Costs>
    <Cost>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Description>Widget</Description>
      <Code />
      <Note />
      <UnitCost>100.00</UnitCost>
      <UnitPrice>130.00</UnitPrice>
      <IncomeAccount />
      <CostOfSaleAccount />
    </Cost>
    <Cost>
      <UUID>cc8236e3-f817-47d0-a1ad-4f3e7d034e6b</UUID>
      <Description>Widget 2</Description>
      <Code />
      <Note />
      <UnitCost>200.00</UnitCost>
      <UnitPrice>260.00</UnitPrice>
      <IncomeAccount />
      <CostOfSaleAccount />
    </Cost>
  </Costs>
</Response>
```


## GET get/\[uuid\]


Detailed information for a specific cost

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Cost>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Description>Widget</Description>
    <Code />
    <Note />
    <UnitCost>100.00</UnitCost>
    <UnitPrice>130.00</UnitPrice>
    <IncomeAccount />
    <CostOfSaleAccount />
  </Cost>
</Response>
```


## POST add


Add a cost

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/add
```


### Example Message

```
<Cost>
  <Description>Widget</Description>
  <Code />
  <Note />
  <UnitCost>100.00</UnitCost>
  <UnitPrice>130.00</UnitPrice>
</Cost>
```


## PUT update


Update a cost

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/update
```


### Example Message

```
<Cost>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
  <Description>Widget</Description>
  <Code />
  <Note />
  <UnitCost>100.00</UnitCost>
  <UnitPrice>130.00</UnitPrice>
</Cost>
```


The response will include the detailed information of the cost as per the GET get/\[identifier\] method

## POST delete


Delete a cost

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/delete
```


### Example Message

```
<Cost>
  <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
</Cost>
```


## POST delete all


Delete all costs

### Example URL

```
https://api.xero.com/practicemanager/3.1/cost.api/deleteall
```


### Example Message

```
<DeleteAll />
```
