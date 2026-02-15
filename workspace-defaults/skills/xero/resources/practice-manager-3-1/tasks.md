# Tasks

| Endpoint | Description |
| --- | --- |
| GET list | Return a list of all tasks |
| [GET get/\[uuid\]](https://developer.xero.com/documentation/api/practice-manager-3-1/tasks#get-getuuid) | Details for a specific task |

## GET list


Return a list of all tasks

### Example URL

```
https://api.xero.com/practicemanager/3.1/task.api/list
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <TaskList>
    <Task>
      <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
      <Name>Concept</Name>
      <Description></Description>
    </Task>
    <Task>
      <UUID>dc6f3aa6-14b2-47bb-9abc-9381e3af07c0</UUID>
      <Name>Design</Name>
      <Description></Description>
    </Task>
  </TaskList>
</Response>
```


## GET get/\[uuid\]


Details for a specific task

### Example URL

```
https://api.xero.com/practicemanager/3.1/task.api/get/f8235e1a-d383-48b7-9139-ba97ab8ca889
```


### Example Response

```
<Response>
  <Status>OK</Status>
  <Task>
    <UUID>f8235e1a-d383-48b7-9139-ba97ab8ca889</UUID>
    <Name>Design</Name>
    <Description></Description>
  </Task>
</Response>
```
