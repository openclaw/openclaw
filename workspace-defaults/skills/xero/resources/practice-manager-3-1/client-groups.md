# Client Groups

| Endpoint | Description |
| --- | --- |
| GET list | Return a list of all client groups |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/client-groups#get-getuuid) | Detailed information for a specific client group |
| POST add | Add a client group |
| PUT members | Manage the members of a client group |
| POST delete | Delete a client group |

## GET list


Return a list of all client groups

### Example URL

```
https://api.xero.com/practicemanager/3.1/clientgroup.api/list
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Groups>
    <Group>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Bloggs Family</Name>
      <Taxable>Yes</Taxable> <!-- Returned if the Practice Management module is enabled -->
    </Group>
    <Group>
      <UUID>46e1db32-6c94-43f6-b5eb-fa082feb1fc4</UUID>
      <Name>Smith Family</Name>
      <Taxable>No</Taxable> <!-- Returned if the Practice Management module is enabled -->
    </Group>
  </Groups>
</Response>
```


## GET get/\[uuid\]


Detailed information for a specific client group

### Example URL

```
https://api.xero.com/practicemanager/3.1/clientgroup.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Group>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Bloggs Family</Name>
    <Taxable>Yes</Taxable> <!-- Returned if the Practice Management module is enabled -->
    <Clients>
      <Client>
        <UUID>c2490566-78e2-4898-ad30-a3b220e98f47</UUID>
        <Name>Jo Bloggs</Name>
      </Client>
      <Client>
        <UUID>d9d3be65-9eb2-4cd4-ace4-e3089f28cfad</UUID>
        <Name>Bloggs Widget Ltd</Name>
      </Client>
    <Clients>
  </Group>
</Response>
```


## POST add


Add a client group

### Example URL

```
https://api.xero.com/practicemanager/3.1/clientgroup.api/add
```


### Example Message

```
<Group>
  <Name>Smith Group</Name>  <!-- Name of Group-->
  <Taxable>No</Name>  <!-- Optional taxable group setting for Practice Manager users-->
  <ClientUUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</ClientUUID>  <!-- Client to add to group -->
</Group>
```


The response will include the detailed information of the client group as per the GET get/\[identifier\] method

## PUT members


Manage the members of a client group

### Example URL

```
https://api.xero.com/practicemanager/3.1/clientgroup.api/members
```


### Example Message

```
<Group>
  <UUID>46e1db32-6c94-43f6-b5eb-fa082feb1fc4</UUID>  <!-- UUID of Group to add client to-->
  <add uuid="5bbc3228-ee39-4d85-8f9a-cfd02c39df20" />  <!-- UUID of client to add to group-->
  <remove uuid="12cd4d38-fcc8-4f9e-8ab3-98ce7f9dc62b" />  <!-- ID of client to remove from group -->
</Group>
```


The response will include the detailed information of the client group as per the GET get/\[identifier\] method

## POST delete


Delete a client group

### Example URL

```
https://api.xero.com/practicemanager/3.1/clientgroup.api/delete
```


### Example Message

```
<Group>
  <UUID>46e1db32-6c94-43f6-b5eb-fa082feb1fc4</UUID>
</Group>
```
